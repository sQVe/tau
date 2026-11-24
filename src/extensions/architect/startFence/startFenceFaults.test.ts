import { afterEach, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { takeStartTicket, useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { architectLockPath } from '../lock.js';
import { acquireStartFence } from './startFence.js';
import type { StartFence } from './startFence.js';

const faults = vi.hoisted(() => ({
  failStartSweep: false,
  failLockRead: false,
  failMarkerRead: false,
  failNextMarkerRead: false,
  failClaimRelease: false,
}));

const namedPath = (path: unknown, name: string): boolean =>
  typeof path === 'string' && path.includes(name);

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const faultyReaddir = (async (
    ...readArguments: Parameters<typeof original.readdir>
  ): Promise<unknown> => {
    const startFolderRead =
      faults.failStartSweep || faults.failMarkerRead || faults.failNextMarkerRead;

    if (startFolderRead && namedPath(readArguments[0], '/start')) {
      faults.failNextMarkerRead = false;

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

  const faultyTruncate = (async (
    ...truncateArguments: Parameters<typeof original.truncate>
  ): Promise<unknown> => {
    if (faults.failClaimRelease && namedPath(truncateArguments[0], '/lock.')) {
      throw new Error('The lock could not be truncated.');
    }

    return original.truncate(...truncateArguments);
  }) as typeof original.truncate;

  const faultyWriteFile = (async (
    ...writeArguments: Parameters<typeof original.writeFile>
  ): Promise<unknown> => {
    if (faults.failClaimRelease && namedPath(writeArguments[0], '.rewrite')) {
      throw new Error('The lock could not be rewritten.');
    }

    return original.writeFile(...writeArguments);
  }) as typeof original.writeFile;

  return {
    ...original,
    readdir: faultyReaddir,
    readFile: faultyReadFile,
    truncate: faultyTruncate,
    writeFile: faultyWriteFile,
  };
});

const resetFaults = (): void => {
  faults.failStartSweep = false;
  faults.failLockRead = false;
  faults.failMarkerRead = false;
  faults.failNextMarkerRead = false;
  faults.failClaimRelease = false;
};

afterEach(resetFaults);

const acquiredFence = async (root: string): Promise<StartFence> => {
  const acquisition = await acquireStartFence(root);

  if (acquisition.kind !== 'acquired') {
    throw new Error('The start fence was not acquired.');
  }

  return acquisition.fence;
};

const takenFence = async (root: string): Promise<StartFence> => {
  const fence = await acquiredFence(root);

  await fence.createTicket();

  expect(await takeStartTicket(fence.wrapArgv(['true']))).toBe(true);

  return fence;
};

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

it('keeps the claim and reports the release failure beside a gone child', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);

  useFakeStartProcess(onTestFinished, 'gone');
  const fence = await takenFence(root);

  faults.failClaimRelease = true;

  const completion = await fence.complete();

  expect(completion.outcome).toBe('gone');
  expect(completion.claim).toBe('kept');

  expect(completion.failure?.message).toBe(
    'The claim could not be released: The lock could not be truncated.',
  );

  expect(completion.failure?.cause).toMatchObject({
    message: 'The lock could not be truncated.',
  });

  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('keeps the claim and reports the marker read failure', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  useFakeStartProcess(onTestFinished, 'running');
  const fence = await takenFence(root);

  faults.failMarkerRead = true;

  const completion = await fence.complete();

  expect(completion.outcome).toBe('unresolved');
  expect(completion.claim).toBe('kept');
  expect(completion.failure?.message).toBe('The child adoption could not be read: EIO: i/o error');
  expect(completion.failure?.cause).toMatchObject({ code: 'EIO' });
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();
});

it('stops a running child after a one-time marker read failure and releases the claim', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running', true);
  const fence = await takenFence(root);

  faults.failNextMarkerRead = true;

  const completion = await fence.complete();

  expect(completion.outcome).toBe('gone');
  expect(completion.claim).toBe('released');
  expect(completion.failure?.message).toBe('The child adoption could not be read: EIO: i/o error');
  expect(processControl.signals).toEqual(['SIGTERM']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('keeps the claim and reports the lock read failure during the stop', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);

  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await takenFence(root);

  faults.failLockRead = true;

  const completion = await fence.complete();

  expect(completion.outcome).toBe('unresolved');
  expect(completion.claim).toBe('kept');

  expect(completion.failure?.message).toBe(
    'The child adoption could not be read: The release read failed.',
  );

  expect(processControl.signals).toEqual([]);
});
