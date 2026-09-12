import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { runChecker } from './checker.js';
import { gitBytes, maximumWorkingBytes, readWorkingEntry, workingState } from './preparation.js';
import type { WorkingEntry } from './preparation.js';
import { hidePending, saveRecovery } from './recovery.js';

export class MessageMutationError extends Error {
  constructor(directory: string, cause: unknown) {
    super(
      `Message check changed the message file. Original and checker output retained at ${directory}. Inspect the checker and retry commit.`,
      { cause },
    );
  }
}

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

const stagedEntries = async (root: string, tree: string, temporaryDirectory: string) => {
  const listed = new TextDecoder('utf-8', { fatal: true }).decode(
    await gitBytes(root, ['ls-tree', '-r', '-l', '-z', tree]),
  );
  let totalBytes = 0;
  const entries = listed
    .split('\0')
    .filter(Boolean)
    .map((row) => {
      const match = /^(100644|100755|120000) blob ([a-f0-9]+) +([0-9]+)\t([\s\S]+)$/.exec(row);

      if (!match?.[1] || !match[2] || !match[3] || !match[4]) {
        throw new Error(
          'Unsupported staged tree. Remove submodules and resolve index conflicts before retrying.',
        );
      }

      const size = Number(match[3]);
      totalBytes += size;

      if (!Number.isSafeInteger(size) || totalBytes > maximumWorkingBytes) {
        throw new Error('Staged recovery exceeds 100 MiB. Reduce staged data before retrying.');
      }

      return match[4];
    });
  const staged: Record<string, WorkingEntry> = {};

  if (!entries.length) {
    return staged;
  }

  const directory = await mkdtemp(join(temporaryDirectory, 'projection-'));
  const index = join(directory, 'index');
  const checkout = join(directory, 'checkout');

  try {
    await mkdir(checkout);
    await gitBytes(root, ['read-tree', tree], index);
    // Use candidate attributes, not unstaged rules. Convert outside the checkout before hiding work.
    await gitBytes(
      root,
      [`--attr-source=${tree}`, 'checkout-index', '--all', `--prefix=${checkout}/`],
      index,
    );
    let bytes = 0;

    for (const path of entries) {
      const snapshot = await readWorkingEntry(checkout, path, maximumWorkingBytes - bytes);
      bytes += snapshot.bytes;
      staged[path] = snapshot.entry;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  return staged;
};

const stagedWorking = async (root: string, tree: string, temporaryDirectory: string) => {
  await gitBytes(root, ['diff-index', '--cached', '--quiet', tree, '--']).catch(
    (error: unknown) => {
      throw new Error('Staged content changed before checks. Retry commit.', { cause: error });
    },
  );

  const staged = await stagedEntries(root, tree, temporaryDirectory);
  const changedPaths = new TextDecoder('utf-8', { fatal: true })
    .decode(await gitBytes(root, ['diff', '--cached', '--no-renames', '--name-only', '-z']))
    .split('\0')
    .filter(Boolean);
  const original = await workingState(root, changedPaths);
  const hidden: Record<string, WorkingEntry> = Object.fromEntries(
    Object.keys(original).map((path) => [path, null]),
  );
  return { ...hidden, ...staged };
};

export const createCandidateChecks = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  tree: string,
  temporaryDirectory: string,
  signal?: AbortSignal,
) => {
  const run = async (arguments_: string[], directory = workingDirectory) => {
    const result = await pi.exec('git', arguments_, {
      cwd: directory,
      ...(signal ? { signal } : {}),
      timeout: 600_000,
    });

    if (result.code !== 0 || result.killed || signal?.aborted) {
      throw new Error(
        `Project check failed (git ${arguments_.join(' ')}):\n${result.stderr}\n${result.stdout}`,
      );
    }

    return result.stdout;
  };
  const repositoryRoot = (await run(['rev-parse', '--show-toplevel'])).replace(/\n$/, '');
  const configPath = await run(['ls-tree', '--name-only', tree, '--', 'tau.json'], repositoryRoot);
  const config = configPath.trim()
    ? parseConfig(await run(['show', `${tree}:tau.json`], repositoryRoot))
    : {};
  const { check: command, checkMessage, hooks = 'run' } = config;
  const messagePath = join(temporaryDirectory, 'message');
  const hooksPath = join(temporaryDirectory, 'empty-hooks');

  if (hooks === 'skip') {
    await mkdir(hooksPath);
  }

  const verifyMessage = async (message: string, diagnostic: string) => {
    const status = await lstat(messagePath).catch(() => null);

    if (!status?.isFile() || !(await readFile(messagePath)).equals(Buffer.from(message))) {
      throw new Error(diagnostic);
    }
  };
  const unavailable = (label: string, key: string) =>
    `${label} unavailable: ${configPath.trim() ? `no ${key} command in tau.json.` : 'no root tau.json.'}`;
  const window = async (message: string | undefined, project: boolean) => {
    if (message !== undefined) {
      await writeFile(messagePath, message, { mode: 0o600 });
      await writeFile(`${messagePath}.original`, message, { mode: 0o600 });
    }

    let projectNotice = unavailable('Project check', 'check');
    let messageResult = { passed: true, notice: unavailable('Message check', 'checkMessage') };

    if (!(project && command) && !(message !== undefined && checkMessage)) {
      return { projectNotice, messageResult };
    }

    const hidden = await stagedWorking(repositoryRoot, tree, temporaryDirectory);
    const archive = await saveRecovery(pi, repositoryRoot, hidden, tree);
    const recovery = await hidePending(pi, repositoryRoot);
    let safeToRestore = true;
    let checkFailure: Error | undefined;
    const check = async (arguments_: string[], label: string) => {
      safeToRestore = false;
      const result = await runChecker(arguments_, repositoryRoot, signal);
      await recovery.assertHidden();
      safeToRestore = true;

      return {
        result,
        notice: `${label} failed (${arguments_.join(' ')}):\n${result.stderr}\n${result.stdout}`,
      };
    };

    try {
      if (project && command) {
        const { result, notice } = await check(command, 'Project check');

        if (result.code !== 0 || result.killed || signal?.aborted) {
          throw new Error(notice);
        }

        projectNotice = `Project check passed: ${command.join(' ')} on ${tree}.`;
      }

      if (message !== undefined && checkMessage) {
        const { result, notice } = await check([...checkMessage, messagePath], 'Message check');
        await verifyMessage(message, 'Message check changed the message file.').catch(
          (error: unknown) => {
            throw new MessageMutationError(temporaryDirectory, error);
          },
        );

        if (result.killed || signal?.aborted) {
          throw new Error(notice);
        }

        messageResult =
          result.code === 0
            ? { passed: true, notice: `Message check passed: ${checkMessage.join(' ')}.` }
            : { passed: false, notice };
      }
    } catch (error) {
      checkFailure = error instanceof Error ? error : new Error(String(error));
    }

    if (!safeToRestore) {
      throw new Error(
        `${String(checkFailure)}\nChecker changed files or index, or termination could not be established. Pending recovery retained at ${archive}. Stop writers and inspect recovery data before retrying.`,
        { cause: checkFailure },
      );
    }

    try {
      await recovery.restore();
    } catch (error) {
      const primaryFailure =
        checkFailure?.message ?? (messageResult.passed ? '' : messageResult.notice);
      throw new Error(
        `${primaryFailure ? `${primaryFailure}\n` : ''}Restoration failed: ${String(error)}\nRecovery retained at ${archive}. Read check-recovery.txt before restoring anything.`,
        { cause: error },
      );
    }

    if (checkFailure) {
      throw checkFailure;
    }

    return { projectNotice, messageResult };
  };

  return {
    hooks,
    hooksPath,
    messagePath,
    verifyMessage,
    checkInitial: (message: string) => window(message, true),
    async checkProject() {
      return (await window(undefined, true)).projectNotice;
    },
    async checkMessage(message: string) {
      return (await window(message, false)).messageResult;
    },
  };
};
