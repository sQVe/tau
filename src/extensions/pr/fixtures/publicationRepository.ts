import type { onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';

type RegisterCleanup = typeof onTestFinished;

export const githubUrl = (repository: string): string => `https://github.com/${repository}.git`;

export const createBareRemote = async (
  registerCleanup: RegisterCleanup,
  url: string,
  checkout: string,
): Promise<string> => {
  const directory = temporaryDirectory(registerCleanup, 'tau-pr-remote-');

  await git(directory, 'init', '--quiet', '--bare', '--initial-branch=main');
  await git(checkout, 'config', `url.${directory}.insteadOf`, url);

  return directory;
};

export const pushFeature = (root: string): Promise<string> =>
  git(root, 'push', '--quiet', '-u', 'origin', 'feature');

// A checkout with a base commit on main and a feature branch that adds one commit. With remote,
// origin is github.com/<origin>, served by a bare remote, and main is pushed. forkPoint is the SHA
// where feature leaves main.
export const createPublicationRepository = async (
  registerCleanup: RegisterCleanup,
  { origin = 'sQVe/tau', remote = false }: { origin?: string; remote?: boolean } = {},
): Promise<{ root: string; forkPoint: string }> => {
  const root = await createTemporaryRepository(registerCleanup);

  await git(root, 'config', 'maintenance.auto', 'false');
  await git(root, 'config', 'gc.auto', '0');

  if (remote) {
    await createBareRemote(registerCleanup, githubUrl(origin), root);
    await git(root, 'remote', 'add', 'origin', githubUrl(origin));
  }

  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'base');

  if (remote) {
    await git(root, 'push', '--quiet', 'origin', 'main');
  }

  const forkPoint = await git(root, 'rev-parse', 'HEAD');

  await git(root, 'checkout', '--quiet', '-b', 'feature');
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'feature');

  return { root, forkPoint };
};
