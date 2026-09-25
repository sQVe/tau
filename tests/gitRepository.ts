import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

// vite.config.ts sets the Git environment for every test process. The repository and the Git calls
// of the code under test then ignore the developer's configuration.
export const initializeRepository = async (directory: string): Promise<void> => {
  await promisify(execFile)('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: directory,
  });
};

export const createTemporaryRepository = async (
  registerCleanup: RegisterCleanup,
  prefix = 'tau-repository-',
): Promise<string> => {
  const repositoryDirectory = await mkdtemp(join(tmpdir(), prefix));
  registerCleanup(() => rm(repositoryDirectory, { recursive: true, force: true }));

  await initializeRepository(repositoryDirectory);

  return repositoryDirectory;
};

// Builds the layout Tau checkouts use: a `.git` file pointing at `.bare`, with worktrees beside it.
export const createTemporaryBareRoot = async (
  registerCleanup: RegisterCleanup,
): Promise<string> => {
  const rootDirectory = await mkdtemp(join(tmpdir(), 'tau-bare-root-'));
  registerCleanup(() => rm(rootDirectory, { recursive: true, force: true }));

  await promisify(execFile)('git', ['init', '--quiet', '--bare', '.bare'], { cwd: rootDirectory });
  await writeFile(join(rootDirectory, '.git'), 'gitdir: .bare\n');

  return rootDirectory;
};
