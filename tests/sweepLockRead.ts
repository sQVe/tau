import * as fsPromises from 'node:fs/promises';

import { onTestFinished, vi } from 'vitest';

import { sweepLockPath } from '../src/extensions/subagents/workerFolderSweep.js';
import { generationPath } from '../src/fileLock/fileLock.js';

const actualFsPromises = await vi.importActual<typeof fsPromises>('node:fs/promises');

// Resolves on the waiting sweep's read of the lock generation its holder published.
// The importing test file must mock node:fs/promises, or this helper cannot observe the read.
export const signalActiveGenerationRead = (
  agentDirectory: string,
  generation: number,
): Promise<void> => {
  if (!vi.isMockFunction(fsPromises.readFile)) {
    throw new Error(
      'signalActiveGenerationRead needs the importing test file to mock node:fs/promises.',
    );
  }

  const path = generationPath(sweepLockPath(agentDirectory), generation);
  const { promise, resolve } = Promise.withResolvers<undefined>();
  const readFile = vi.mocked(fsPromises.readFile);
  const original = readFile.getMockImplementation() ?? actualFsPromises.readFile;

  readFile.mockImplementation((...parameters: Parameters<typeof fsPromises.readFile>) => {
    const [target] = parameters;

    if (target === path) {
      resolve(undefined);
    }

    return original(...parameters);
  });

  onTestFinished(() => {
    readFile.mockImplementation(original);
  });

  return promise;
};
