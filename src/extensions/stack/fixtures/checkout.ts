import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';

type RegisterCleanup = (cleanup: () => Promise<void>) => void;

export const git = async (cwd: string, ...commandArguments: string[]): Promise<string> => {
  const { stdout } = await promisify(execFile)('git', commandArguments, { cwd });

  return stdout.trim();
};

// A checkout whose origin is github.com/sQVe/tau, backed by a local bare repository, with main
// pushed and checked out.
export const createStackCheckout = async (registerCleanup: RegisterCleanup): Promise<string> => {
  const root = await createTemporaryRepository(registerCleanup);
  const remote = await mkdtemp(join(tmpdir(), 'tau-stack-remote-'));

  registerCleanup(() => rm(remote, { recursive: true, force: true }));

  await git(root, 'config', 'maintenance.auto', 'false');
  await git(root, 'config', 'gc.auto', '0');
  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await git(root, 'config', `url.${remote}.insteadOf`, 'https://github.com/sQVe/tau.git');
  await git(root, 'remote', 'add', 'origin', 'https://github.com/sQVe/tau.git');
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'base');
  await git(root, 'push', '--quiet', '-u', 'origin', 'main');

  return root;
};
