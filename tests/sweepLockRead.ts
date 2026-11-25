import * as fsPromises from 'node:fs/promises';

import { onTestFinished, vi } from 'vitest';

import { sweepLockPath } from '../src/extensions/subagents/workerFolderSweep.js';
import { generationPath } from '../src/fileLock/fileLock.js';

const actualFsPromises = await vi.importActual<typeof fsPromises>('node:fs/promises');

// Resolves on the waiting sweep's read of the lock generation its holder published.
export const signalActiveGenerationRead = (agentDirectory: string): Promise<void> => {
  const path = generationPath(sweepLockPath(agentDirectory), 1);
  const { promise, resolve } = Promise.withResolvers<undefined>();
  const readFile = vi.mocked(fsPromises.readFile);
  const original = readFile.getMockImplementation() ?? actualFsPromises.readFile;

  readFile.mockImplementation(((target: string, ...rest: never[]) => {
    if (target === path) {
      resolve(undefined);
    }

    return original(target, ...rest);
  }) as typeof fsPromises.readFile);

  onTestFinished(() => {
    readFile.mockImplementation(original);
  });

  return promise;
};
