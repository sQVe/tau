import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

    if (key === 'checkMessage' || key === 'hooks') {
      throw new Error(
        `tau.json ${key} is reserved and not implemented. Remove it; Git hooks still run normally.`,
      );
    }

    if (key !== 'prepare' && key !== 'check') {
      throw new Error(`Unknown tau.json setting "${key}". Only prepare and check are supported.`);
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

// Prepare the working tree before even temporary staging for batch review planning.
export const prepareProject = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  signal?: AbortSignal,
): Promise<string> => {
  const root = await pi.exec('git', ['rev-parse', '--show-toplevel'], { cwd: workingDirectory });

  if (root.code !== 0) {
    throw new Error(`Project preparation failed: ${root.stderr || root.stdout}`);
  }

  const repositoryRoot = root.stdout.trim();
  let configContent: string;

  try {
    configContent = await readFile(join(repositoryRoot, 'tau.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'Project preparation unavailable: no root tau.json.';
    }

    throw error;
  }

  // Validate every setting before preparation can change working files.
  const { prepare: command } = parseConfig(configContent);

  if (!command) {
    return 'Project preparation unavailable: no prepare command in tau.json.';
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

// Check the index snapshot: unstaged fixes must not make an incomplete commit pass.
export const checkProject = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  tree: string,
  signal?: AbortSignal,
): Promise<string> => {
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
  const repositoryRoot = rootOutput.trim();
  const configPath = await run(
    'git',
    ['ls-tree', '--name-only', tree, '--', 'tau.json'],
    repositoryRoot,
  );

  if (!configPath.trim()) {
    return 'Project check unavailable: no root tau.json.';
  }

  const configContent = await run('git', ['show', `${tree}:tau.json`], repositoryRoot);
  const { check: command } = parseConfig(configContent);

  if (!command) {
    return 'Project check unavailable: no check command in tau.json.';
  }

  const [executable, ...arguments_] = command;

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tau-project-check-'));
  const candidateDirectory = join(temporaryDirectory, 'candidate');

  try {
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

    await run(executable, arguments_, candidateDirectory);

    const changedFiles = await run('git', ['diff', '--name-only', tree, '--'], candidateDirectory);

    if (changedFiles.trim()) {
      throw new Error(
        'Project check changed tracked files. Run it locally, review the changes, and retry commit.',
      );
    }

    return `Project check passed: ${command.join(' ')} on ${tree}.`;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
