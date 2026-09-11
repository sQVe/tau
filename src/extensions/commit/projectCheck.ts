import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

interface CommitConfig {
  prepare?: [string, ...string[]];
  check?: [string, ...string[]];
  checkMessage?: [string, ...string[]];
  hooks?: 'run' | 'skip';
}

const parseConfig = (content: string): CommitConfig => {
  let config: unknown;

  try {
    config = JSON.parse(content);
  } catch (error) {
    throw new Error('Invalid tau.json: must contain valid JSON.', { cause: error });
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('tau.json must be an object.');
  }

  const commands: CommitConfig = {};

  for (const key of Object.keys(config)) {
    if (key === 'fix') {
      throw new Error('Obsolete tau.json fix setting: rename fix to prepare.');
    }

    if (key === 'hooks') {
      const hooks: unknown = Reflect.get(config, key);

      if (hooks !== 'run' && hooks !== 'skip') {
        throw new Error('tau.json hooks must be "run" or "skip".');
      }

      commands.hooks = hooks;
      continue;
    }

    if (key !== 'prepare' && key !== 'check' && key !== 'checkMessage') {
      throw new Error(
        `Unknown tau.json setting "${key}". Only prepare, check, checkMessage and hooks are supported.`,
      );
    }

    const command: unknown = Reflect.get(config, key);

    if (
      !Array.isArray(command) ||
      !command.every(
        (part: unknown): part is string => typeof part === 'string' && !part.includes('\0'),
      )
    ) {
      throw new Error(`tau.json ${key} must be a nonempty argv array of strings without NULs.`);
    }

    const [executable, ...arguments_] = command;

    if (!executable?.trim()) {
      throw new Error(`tau.json ${key} must be a nonempty argv array with a nonblank executable.`);
    }

    commands[key] = [executable, ...arguments_];
  }

  return commands;
};

export const readPreparation = async (pi: Pick<ExtensionAPI, 'exec'>, workingDirectory: string) => {
  const root = await pi.exec('git', ['rev-parse', '--show-toplevel'], { cwd: workingDirectory });

  if (root.code !== 0) {
    throw new Error(`Project preparation failed: ${root.stderr || root.stdout}`);
  }

  const repositoryRoot = root.stdout.replace(/\n$/, '');
  let configContent: string;

  try {
    configContent = await readFile(join(repositoryRoot, 'tau.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { repositoryRoot, notice: 'Project preparation unavailable: no root tau.json.' };
    }

    throw error;
  }

  const { prepare: command } = parseConfig(configContent);

  return {
    repositoryRoot,
    command,
    notice: 'Project preparation unavailable: no prepare command in tau.json.',
  };
};

export type Preparation = Awaited<ReturnType<typeof readPreparation>>;

export const prepareProject = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  preparation: Preparation,
  signal?: AbortSignal,
): Promise<string> => {
  const { repositoryRoot, command, notice } = preparation;

  if (!command) {
    return notice;
  }

  const [executable, ...arguments_] = command;

  const result = await pi.exec(executable, arguments_, {
    cwd: repositoryRoot,
    ...(signal ? { signal } : {}),
    timeout: 600_000,
  });

  if (result.code !== 0 || result.killed || signal?.aborted) {
    throw new Error(
      `Project preparation failed (${command.join(' ')}):\n${result.stderr}\n${result.stdout}`,
    );
  }

  return `Project preparation passed: ${command.join(' ')}.`;
};

// Both checks use one staged checkout. Message edits never repeat the project check.
export const createCandidateChecks = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  tree: string,
  temporaryDirectory: string,
  signal?: AbortSignal,
) => {
  const run = async (command: string, commandArguments: string[], directory = workingDirectory) => {
    const result = await pi.exec(command, commandArguments, {
      cwd: directory,
      ...(signal ? { signal } : {}),
      timeout: 600_000,
    });

    if (result.code !== 0 || result.killed || signal?.aborted) {
      throw new Error(
        `Project check failed (${command} ${commandArguments.join(' ')}):\n${result.stderr}\n${result.stdout}`,
      );
    }

    return result.stdout;
  };

  const rootOutput = await run('git', ['rev-parse', '--show-toplevel']);
  const repositoryRoot = rootOutput.replace(/\n$/, '');
  const configPath = await run(
    'git',
    ['ls-tree', '--name-only', tree, '--', 'tau.json'],
    repositoryRoot,
  );

  const config = configPath.trim()
    ? parseConfig(await run('git', ['show', `${tree}:tau.json`], repositoryRoot))
    : {};
  const { check: command, checkMessage, hooks = 'run' } = config;
  const candidateDirectory = join(temporaryDirectory, 'candidate');
  const messagePath = join(temporaryDirectory, 'message');
  const hooksPath = join(temporaryDirectory, 'empty-hooks');

  if (hooks === 'skip') {
    await mkdir(hooksPath);
  }

  if (command || checkMessage) {
    await run('git', [
      'clone',
      '--shared',
      '--no-checkout',
      '--',
      repositoryRoot,
      candidateDirectory,
    ]);
    await run('git', ['read-tree', tree], candidateDirectory);
    await run('git', ['checkout-index', '--all'], candidateDirectory);

    // ponytail: root dependencies are shared; workspace-aware installs need a separate checkout strategy.
    const dependencies = join(repositoryRoot, 'node_modules');
    const candidateDependencies = join(candidateDirectory, 'node_modules');
    const dependenciesExist = await exists(dependencies);
    const candidateDependenciesExist = await exists(candidateDependencies);

    // A tracked node_modules is already checked out, and its staged content is what the check must see.
    if (dependenciesExist && !candidateDependenciesExist) {
      await symlink(dependencies, candidateDependencies, 'junction');
    }
  }

  const assertCandidate = async (label: string) => {
    const changedFiles = await run('git', ['diff', '--name-only', tree, '--'], candidateDirectory);
    const candidateTree = await run('git', ['write-tree'], candidateDirectory);

    if (changedFiles.trim() || candidateTree.trim() !== tree) {
      throw new Error(
        `${label} changed tracked files or index. Inspect the checker and retry commit.`,
      );
    }
  };

  const untrackedState = async () => {
    // Git omits FIFOs and sockets from ls-files. Inspect entry types without opening their contents.
    const workingEntries = await readdir(candidateDirectory, {
      recursive: true,
      withFileTypes: true,
    });

    if (
      workingEntries.some(
        (entry) => !entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink(),
      )
    ) {
      throw new Error(
        'Message check changed the candidate: unsupported special file. Fix the checker and retry.',
      );
    }

    const listed = await run(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      candidateDirectory,
    );
    const entries = await Promise.all(
      listed
        .split('\0')
        .filter(Boolean)
        .toSorted()
        .map(async (path) => {
          const absolute = join(candidateDirectory, path);
          const status = await lstat(absolute);

          if (!status.isFile() && !status.isSymbolicLink()) {
            throw new Error(
              `Message check changed the candidate: unsupported file ${JSON.stringify(path)}. Retry after fixing the checker.`,
            );
          }

          const content = status.isSymbolicLink()
            ? await readlink(absolute, { encoding: 'buffer' })
            : await readFile(absolute);

          return [path, status.mode, content.toString('base64')];
        }),
    );

    return JSON.stringify(entries);
  };

  const verifyMessage = async (message: string, diagnostic: string) => {
    const status = await lstat(messagePath).catch(() => null);

    if (!status?.isFile()) {
      throw new Error(diagnostic);
    }

    const bytes = await readFile(messagePath);

    if (!bytes.equals(Buffer.from(message))) {
      throw new Error(diagnostic);
    }
  };

  const assertMessageCheck = async (before: string, message: string) => {
    await assertCandidate('Message check');
    const after = await untrackedState();
    const diagnostic =
      'Message check changed the candidate or message file. Inspect the checker and retry commit.';

    if (before !== after) {
      throw new Error(diagnostic);
    }

    await verifyMessage(message, diagnostic);
  };

  return {
    hooks,
    hooksPath,
    messagePath,
    verifyMessage,
    async checkProject() {
      if (!command) {
        return `Project check unavailable: ${configPath.trim() ? 'no check command in tau.json.' : 'no root tau.json.'}`;
      }

      const [executable, ...arguments_] = command;

      await run(executable, arguments_, candidateDirectory);
      await assertCandidate('Project check');

      return `Project check passed: ${command.join(' ')} on ${tree}.`;
    },
    async checkMessage(message: string) {
      await writeFile(messagePath, message, { mode: 0o600 });

      if (!checkMessage) {
        return {
          passed: true,
          notice: `Message check unavailable: ${configPath.trim() ? 'no checkMessage command in tau.json.' : 'no root tau.json.'}`,
        };
      }

      await assertCandidate('Message check');
      const before = await untrackedState();
      const [executable, ...arguments_] = checkMessage;
      let result: Awaited<ReturnType<ExtensionAPI['exec']>>;

      try {
        result = await pi.exec(executable, [...arguments_, messagePath], {
          cwd: candidateDirectory,
          ...(signal ? { signal } : {}),
          timeout: 600_000,
        });
      } finally {
        // Check mutations even after failure or a killed process. A dirty checkout cannot be retried.
        if (!signal?.aborted) {
          await assertMessageCheck(before, message);
        }
      }

      const notice = `Message check failed (${checkMessage.join(' ')}):\n${result.stderr}\n${result.stdout}`;

      if (result.killed || signal?.aborted) {
        throw new Error(notice);
      }

      return result.code === 0
        ? { passed: true, notice: `Message check passed: ${checkMessage.join(' ')}.` }
        : { passed: false, notice };
    },
  };
};
