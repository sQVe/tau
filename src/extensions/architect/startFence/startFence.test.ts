import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { replaceCurrentLockOwnerPid } from '../../../../tests/lockOwnerRecord.js';
import {
  fakeStartProcessId,
  takeStartTicket,
  useFakeStartProcess,
} from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { architectLockPath, holdArchitectLock } from '../lock.js';
import { acquireStartFence } from './startFence.js';
import type { StartFence } from './startFence.js';

const poll = vi.hoisted(() => ({ started: Promise.withResolvers<undefined>() }));

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../../../tests/timerFake.js');

  const delay = (<T>(milliseconds?: number, value?: T, options?: { signal?: AbortSignal }) => {
    poll.started.resolve(undefined);

    return globalTimerDelay(milliseconds, value, options);
  }) as typeof original.setTimeout;

  return { ...original, setTimeout: delay };
});

beforeEach(() => {
  poll.started = Promise.withResolvers<undefined>();
});

afterEach(() => {
  vi.useRealTimers();
});

const startFakeTimers = (): void => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
};

const startDirectory = (root: string): string => join(root, '.tau', 'architect', 'start');

const adoptTakenTicket = async (root: string): Promise<void> => {
  const directory = startDirectory(root);
  const names = await readdir(directory);
  const started = names.find((name) => name.includes('.started.'));

  if (started === undefined) {
    throw new Error('The child did not take the ticket.');
  }

  await rename(
    join(directory, started),
    join(directory, started.replace('.started.', '.adopted.')),
  );
};

const acquiredFence = async (root: string): Promise<StartFence> => {
  const acquisition = await acquireStartFence(root);

  if (acquisition.kind !== 'acquired') {
    throw new Error('The start fence was not acquired.');
  }

  return acquisition.fence;
};

it('keeps the adopted child after the adopter releases its lock and never signals it', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await acquiredFence(root);

  await fence.createTicket();

  expect(await takeStartTicket(fence.wrapArgv(['true']))).toBe(true);

  const adopted = await holdArchitectLock(root, fence.token);

  await adoptTakenTicket(root);
  await adopted.release();

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await fence.abandon()).toEqual({ adopted: true });
  expect(await fence.abandon()).toEqual({ adopted: true });

  const finished = await fence.finish({ adopted: true, stopAttempted: true });

  expect(finished).toEqual({ kept: false });
  expect(processControl.signals).toEqual([]);
});

it('sends no second signal when the child adopts during the stop', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await acquiredFence(root);

  await fence.createTicket();

  expect(await takeStartTicket(fence.wrapArgv(['true']))).toBe(true);
  await fence.recordStarted();

  startFakeTimers();

  const finishing = fence.finish({ adopted: false, stopAttempted: false });

  await poll.started.promise;
  await adoptTakenTicket(root);
  await vi.advanceTimersByTimeAsync(10_000);

  const finished = await finishing;

  expect(finished).toEqual({ kept: false });
  expect(processControl.signals).toEqual(['SIGTERM']);
});

it('re-probes the child when its marker is gone', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await acquiredFence(root);

  await fence.createTicket();

  expect(await takeStartTicket(fence.wrapArgv(['true']))).toBe(true);
  await fence.recordStarted();

  processControl.state = 'gone';
  await rm(startDirectory(root), { recursive: true, force: true });

  expect(await fence.refreshChild()).toBe('gone');
});

it('keeps a lock-only adoption cached after the lock is gone', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await acquiredFence(root);

  await fence.createTicket();

  expect(await takeStartTicket(fence.wrapArgv(['true']))).toBe(true);

  await fence.recordStarted();

  const holder = await holdArchitectLock(root, fence.token);

  expect(await fence.childAdopted()).toBe(false);

  await replaceCurrentLockOwnerPid(architectLockPath(root), fakeStartProcessId);

  expect(await fence.childAdopted()).toBe(true);

  await holder.release();

  expect(await fence.childAdopted()).toBe(true);

  const finished = await fence.finish({ adopted: false, stopAttempted: false });

  expect(finished).toEqual({ kept: false });
  expect(processControl.signals).toEqual([]);
});
