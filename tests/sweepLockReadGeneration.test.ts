import * as fsPromises from 'node:fs/promises';

import { expect, it, vi } from 'vitest';

import { sweepLockPath } from '../src/extensions/subagents/workerFolderSweep.js';
import { generationPath } from '../src/fileLock/fileLock.js';
import { signalActiveGenerationRead } from './sweepLockRead.js';

vi.mock(import('node:fs/promises'), { spy: true });

const agentDirectory = '/agent';

const readFileQuietly = (path: string): Promise<unknown> =>
  fsPromises.readFile(path).catch(() => undefined);

it('resolves only on the read of the generation its caller names', async () => {
  const watching = signalActiveGenerationRead(agentDirectory, 2);
  let resolved = false;

  const observed = watching.then(() => {
    resolved = true;

    return undefined;
  });

  await readFileQuietly(generationPath(sweepLockPath(agentDirectory), 1));
  await Promise.resolve();

  expect(resolved).toBe(false);

  await readFileQuietly(generationPath(sweepLockPath(agentDirectory), 2));

  await observed;
});
