import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import type { onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../../tests/gitRepository.js';
import { createGhFake } from '../../../../tests/prGhFake.js';
import type { GhFake } from '../../../../tests/prGhFake.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { noUiContext } from '../../../../tests/toolContext.js';
import { createPrTool } from '../tool.js';
import type { PrInput } from '../tool.js';

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

const createPublicationRepository = async (
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

const toolContext = (root: string) =>
  ({
    ...noUiContext(root),
    isProjectTrusted: () => false,
    ui: { notify: () => undefined },
  }) as unknown as ExtensionToolContext;

// A publication repository whose origin github.com/<origin> the gh fake knows, and a run that
// calls the pr tool in it.
export const createPublicationTool = async (
  registerCleanup: RegisterCleanup,
  { origin = 'sQVe/tau', remote = false }: { origin?: string; remote?: boolean } = {},
): Promise<{
  root: string;
  forkPoint: string;
  fake: GhFake;
  run: (input: PrInput) => Promise<Record<string, unknown>>;
}> => {
  const { root, forkPoint } = await createPublicationRepository(registerCleanup, {
    origin,
    remote,
  });

  const fake = createGhFake();
  const agentDirectory = temporaryDirectory(registerCleanup, 'tau-pr-tool-agent-');

  fake.repositories[`github.com/${origin}`] = { defaultBranch: 'main' };

  const run = async (input: PrInput) => {
    const tool = createPrTool(fake.exec, { agentDirectory });
    const result = await tool.execute('call', input, undefined, undefined, toolContext(root));

    return result.details;
  };

  return { root, forkPoint, fake, run };
};
