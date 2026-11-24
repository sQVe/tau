import { readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { replaceCurrentLockOwnerPid } from '../../../../tests/lockOwnerRecord.js';
import { takenFence } from '../../../../tests/startFenceHarness.js';
import { fakeStartProcessId, useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { architectLockPath, holdArchitectLock } from '../lock.js';
import {
  malformedStartMarkerReason,
  startHeldByProcessReason,
} from '../startTicket/startTicket.js';
import { startFenceBlockerMessage } from './startFence.js';

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

it('reports adoption without signalling a child that adopted and released its lock', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await takenFence(root);

  const adopted = await holdArchitectLock(root, fence.token);

  await adoptTakenTicket(root);
  await adopted.release();

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await fence.complete()).toEqual({ outcome: 'adopted', claim: 'released' });
  expect(processControl.signals).toEqual([]);
});

it('reports adoption when the child adopts during the stop and sends no second signal', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await takenFence(root);

  await fence.recordStarted();
  startFakeTimers();

  const completing = fence.complete();

  await poll.started.promise;
  await adoptTakenTicket(root);
  await vi.advanceTimersByTimeAsync(10_000);

  expect(await completing).toEqual({ outcome: 'adopted', claim: 'released' });
  expect(processControl.signals).toEqual(['SIGTERM']);
});

it('keeps a lock-only adoption cached after the lock is gone', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  useFakeStartProcess(onTestFinished, 'running');
  const fence = await takenFence(root);

  await fence.recordStarted();

  const adopted = await holdArchitectLock(root, fence.token);

  await replaceCurrentLockOwnerPid(architectLockPath(root), fakeStartProcessId);

  expect(await fence.waitForTakeover(Date.now() + 1_000)).toBe('adopted');

  await adopted.release();

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(await fence.complete()).toEqual({ outcome: 'adopted', claim: 'released' });
});

it('stops a child that never adopted, releases the claim, and deletes its marker', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running', true);
  const fence = await takenFence(root);

  await fence.recordStarted();

  expect(await fence.complete()).toEqual({ outcome: 'gone', claim: 'released' });
  expect(processControl.signals).toEqual(['SIGTERM']);
  expect(await readdir(startDirectory(root))).toEqual([]);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('keeps the claim when the child neither ends nor adopts', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await takenFence(root);

  await fence.recordStarted();
  startFakeTimers();

  const completing = fence.complete();

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(5_000);
  await processControl.nextSignal(1);
  await processControl.nextSignal(2);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(await completing).toEqual({ outcome: 'unresolved', claim: 'kept' });
  expect(processControl.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeDefined();

  const names = await readdir(startDirectory(root));

  expect(names.some((name) => name.includes('.started.'))).toBe(true);
});

it('returns one memoized completion', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  useFakeStartProcess(onTestFinished, 'running');
  const fence = await takenFence(root);

  const adopted = await holdArchitectLock(root, fence.token);

  await replaceCurrentLockOwnerPid(architectLockPath(root), fakeStartProcessId);

  const completion = await fence.complete();

  expect(completion).toEqual({ outcome: 'adopted', claim: 'released' });

  await adopted.release();

  expect(await fence.complete()).toBe(completion);
});

it('reports a gone child whose marker is gone', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const processControl = useFakeStartProcess(onTestFinished, 'running');
  const fence = await takenFence(root);

  await fence.recordStarted();

  processControl.state = 'gone';
  await rm(startDirectory(root), { recursive: true, force: true });

  expect(await fence.complete()).toEqual({ outcome: 'gone', claim: 'released' });
});

it.each([
  { name: 'a starting blocker', blocker: { kind: 'starting' as const }, expected: undefined },
  {
    name: 'a running process',
    blocker: { kind: 'runningProcess' as const, processId: 4321 },
    expected: startHeldByProcessReason(4321),
  },
  {
    name: 'a malformed marker',
    blocker: { kind: 'malformedMarker' as const, path: '/start/marker' },
    expected: malformedStartMarkerReason('/start/marker'),
  },
])('names the message for $name', ({ blocker, expected }) => {
  expect(startFenceBlockerMessage(blocker)).toBe(expected);
});
