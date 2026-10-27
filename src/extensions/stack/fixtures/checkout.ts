import { onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

// A checkout whose origin is github.com/sQVe/tau, backed by a local bare repository, with main
// pushed and checked out.
export const createStackCheckout = async (registerCleanup: RegisterCleanup): Promise<string> => {
  const root = await createTemporaryRepository(registerCleanup);
  const remote = temporaryDirectory(onTestFinished, 'tau-stack-remote-');

  await git(root, 'config', 'maintenance.auto', 'false');
  await git(root, 'config', 'gc.auto', '0');
  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await git(root, 'config', `url.${remote}.insteadOf`, 'https://github.com/sQVe/tau.git');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'base');
  await git(root, 'push', '--quiet', '-u', 'origin', 'main');

  return root;
};
