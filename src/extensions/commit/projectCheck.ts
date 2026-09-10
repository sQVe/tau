import { access, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const scriptPackageManager = (manifestContent: string, script: 'check' | 'fix') => {
  const label = script === 'fix' ? 'Project fixer' : 'Project check';
  const manifest: unknown = JSON.parse(manifestContent);

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${label} failed: package.json must be an object.`);
  }

  if (!('scripts' in manifest) || !manifest.scripts || typeof manifest.scripts !== 'object') {
    return undefined;
  }

  const command: unknown = Reflect.get(manifest.scripts, script);

  if (typeof command !== 'string' || !command.trim()) {
    return undefined;
  }

  let packageManager: string | undefined = 'npm';

  if ('packageManager' in manifest) {
    packageManager =
      typeof manifest.packageManager === 'string'
        ? manifest.packageManager.split('@')[0]
        : undefined;
  }

  if (!packageManager || !['npm', 'pnpm', 'yarn', 'bun'].includes(packageManager)) {
    throw new Error(`${label} failed: unsupported packageManager. Use npm, pnpm, yarn, or bun.`);
  }

  return packageManager;
};

// Fix the working tree before even temporary staging for batch review planning.
export const fixProject = async (
  pi: Pick<ExtensionAPI, 'exec'>,
  workingDirectory: string,
  signal?: AbortSignal,
): Promise<string> => {
  const root = await pi.exec('git', ['rev-parse', '--show-toplevel'], { cwd: workingDirectory });

  if (root.code !== 0) {
    throw new Error(`Project fixer failed: ${root.stderr || root.stdout}`);
  }

  const repositoryRoot = root.stdout.trim();
  let manifestContent: string;

  try {
    manifestContent = await readFile(join(repositoryRoot, 'package.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'Project fixer unavailable: no root package.json.';
    }

    throw error;
  }

  const packageManager = scriptPackageManager(manifestContent, 'fix');

  if (!packageManager) {
    return 'Project fixer unavailable: no root scripts.fix.';
  }

  const result = await pi.exec(packageManager, ['run', 'fix'], {
    cwd: repositoryRoot,
    ...(signal ? { signal } : {}),
    timeout: 600_000,
  });

  if (result.code !== 0 || result.killed || signal?.aborted) {
    throw new Error(
      `Project fixer failed (${packageManager} run fix):\n${result.stderr}\n${result.stdout}`,
    );
  }

  return `Project fixer passed: ${packageManager} run fix.`;
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
  const manifestPath = await run(
    'git',
    ['ls-tree', '--name-only', tree, '--', 'package.json'],
    repositoryRoot,
  );

  if (!manifestPath.trim()) {
    return 'Project check unavailable: no root package.json.';
  }

  const manifestContent = await run('git', ['show', `${tree}:package.json`], repositoryRoot);
  const packageManager = scriptPackageManager(manifestContent, 'check');

  if (!packageManager) {
    return 'Project check unavailable: no root scripts.check.';
  }

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

    await run(packageManager, ['run', 'check'], candidateDirectory);

    const changedFiles = await run('git', ['diff', '--name-only', tree, '--'], candidateDirectory);

    if (changedFiles.trim()) {
      throw new Error(
        'Project check changed tracked files. Run it locally, review the changes, and retry commit.',
      );
    }

    return `Project check passed: ${packageManager} run check on ${tree}.`;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};
