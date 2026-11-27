import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { forgetTemporaryDirectory, trackTemporaryDirectory } from './temporaryDirectoryHarness.ts';

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

// Callers compare the output directly, so the helper drops the trailing newline.
export const git = async (cwd: string, ...commandArguments: string[]): Promise<string> => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd });

  return stdout.trimEnd();
};

// vite.config.ts sets the Git environment for every test process. The repository and the Git calls
// of the code under test then ignore the developer's configuration.
export const initializeRepositorySync = (directory: string): void => {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: directory });
};

// A test that awaits its first step can create its repository here.
export const initializeRepository = async (directory: string): Promise<void> => {
  await promisify(execFile)('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: directory,
  });
};

// The cleanup callback removes the repository even when its test fails.
export const createTemporaryRepository = async (
  registerCleanup: RegisterCleanup,
  prefix = 'tau-repository-',
): Promise<string> => {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), prefix));

  trackTemporaryDirectory(repositoryDirectory);

  registerCleanup(async () => {
    await rm(repositoryDirectory, { recursive: true, force: true });
    forgetTemporaryDirectory(repositoryDirectory);
  });

  await initializeRepository(repositoryDirectory);

  return repositoryDirectory;
};

export const createTemporaryBareRepository = async (
  registerCleanup: RegisterCleanup,
): Promise<string> => {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), 'tau-bare-repository-'));
  registerCleanup(() => rm(repositoryDirectory, { recursive: true, force: true }));

  await promisify(execFile)('git', ['init', '--quiet', '--bare'], { cwd: repositoryDirectory });

  return repositoryDirectory;
};

// A bare root keeps the worktree and its Git directory under one temporary directory.
// The `.git` file holds a relative path, so the root can move as one directory.
// Builds the layout Tau checkouts use: a `.git` file pointing at `.bare`, with worktrees beside it.
export const createTemporaryBareRoot = async (
  registerCleanup: RegisterCleanup,
): Promise<string> => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'tau-bare-root-'));

  trackTemporaryDirectory(rootDirectory);

  registerCleanup(async () => {
    await rm(rootDirectory, { recursive: true, force: true });
    forgetTemporaryDirectory(rootDirectory);
  });

  await promisify(execFile)('git', ['init', '--quiet', '--bare', '.bare'], { cwd: rootDirectory });
  await writeFile(join(rootDirectory, '.git'), 'gitdir: .bare\n');

  return rootDirectory;
};
