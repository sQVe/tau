import { afterEach, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { acquireStartFence } from './startFence.js';

const faults = vi.hoisted(() => ({ failStartSweep: false, failLockRead: false }));

const namedPath = (path: unknown, name: string): boolean =>
  typeof path === 'string' && path.includes(name);

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const faultyReaddir = (async (
    ...readArguments: Parameters<typeof original.readdir>
  ): Promise<unknown> => {
    if (faults.failStartSweep && namedPath(readArguments[0], '/start')) {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    }

    return original.readdir(...readArguments);
  }) as typeof original.readdir;

  const faultyReadFile = (async (
    ...readArguments: Parameters<typeof original.readFile>
  ): Promise<unknown> => {
    if (faults.failLockRead && namedPath(readArguments[0], '/lock.')) {
      throw new Error('The release read failed.');
    }

    return original.readFile(...readArguments);
  }) as typeof original.readFile;

  return { ...original, readdir: faultyReaddir, readFile: faultyReadFile };
});

const resetFaults = (): void => {
  faults.failStartSweep = false;
  faults.failLockRead = false;
};

afterEach(resetFaults);

it('reports the sweep failure and the release failure together', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  faults.failStartSweep = true;
  faults.failLockRead = true;

  const thrown: unknown = await acquireStartFence(root).catch((error: unknown) => error);
  const failure = thrown as Error;

  expect(failure.message).toContain('The start sweep failed: EIO: i/o error');
  expect(failure.message).toContain('releasing the claim failed: The release read failed.');
  expect(failure.cause).toMatchObject({ message: 'EIO: i/o error' });
});
