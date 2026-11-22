import { expect, it, vi } from 'vitest';

import { failedResult, succeededResult } from '../../tests/execFake.js';
import type { HcRuntime } from './hc.js';
import { ownershipTiming, waitForOwnership } from './ownership.js';

const foregroundReply = (pid: number | null): string => {
  const foreground = pid === null ? null : { pid, name: 'pi', argv: ['pi'], cwd: '/repo' };

  return JSON.stringify({ address: 't7', state: 'live', foreground, labels: {} });
};

const runtimeFor = (replies: readonly string[]) => {
  const reads: string[] = [];

  const runtime: HcRuntime = {
    cwd: '/repo',
    connect: () => Promise.reject(new Error('no connect')),
    exec: (_command, commandArguments) => {
      const reply = replies[Math.min(reads.length, replies.length - 1)] ?? '';

      reads.push(commandArguments.join(' '));

      return Promise.resolve(succeededResult(reply));
    },
  };

  return { runtime, reads };
};

const useFakeTimers = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
};

it('resolves notOwner on the first read when another process group leads the terminal', async () => {
  const { runtime, reads } = runtimeFor([foregroundReply(999)]);
  const request = { terminal: 't7', processGroup: 100, signal: new AbortController().signal };

  await expect(waitForOwnership(runtime, request)).resolves.toBe('notOwner');
  expect(reads).toHaveLength(1);
});

it('resolves owner after the terminal reports its foreground only later', async () => {
  useFakeTimers();

  const { runtime, reads } = runtimeFor([
    foregroundReply(null),
    foregroundReply(null),
    foregroundReply(100),
  ]);

  const request = { terminal: 't7', processGroup: 100, signal: new AbortController().signal };
  const pending = waitForOwnership(runtime, request);

  await vi.advanceTimersByTimeAsync(ownershipTiming.intervalMilliseconds * 2);

  await expect(pending).resolves.toBe('owner');
  expect(reads).toHaveLength(3);
});

it('starts no new read after the deadline passes during a slow read', async () => {
  useFakeTimers();

  const reads: string[] = [];

  const runtime: HcRuntime = {
    cwd: '/repo',
    connect: () => Promise.reject(new Error('no connect')),
    exec: () => {
      reads.push('get');
      vi.advanceTimersByTime(ownershipTiming.deadlineMilliseconds - 50);

      return Promise.resolve(succeededResult(foregroundReply(null)));
    },
  };

  const request = { terminal: 't7', processGroup: 100, signal: new AbortController().signal };
  const pending = waitForOwnership(runtime, request);

  await vi.advanceTimersByTimeAsync(ownershipTiming.intervalMilliseconds);

  await expect(pending).resolves.toBe('noForeground');
  expect(reads).toHaveLength(1);
});

it('resolves noForeground when the terminal reports no foreground for the deadline', async () => {
  useFakeTimers();

  const { runtime } = runtimeFor([foregroundReply(null)]);
  const request = { terminal: 't7', processGroup: 100, signal: new AbortController().signal };
  const pending = waitForOwnership(runtime, request);

  await vi.advanceTimersByTimeAsync(ownershipTiming.deadlineMilliseconds);

  await expect(pending).resolves.toBe('noForeground');
});

it('rejects with the read error on a malformed get reply', async () => {
  const runtime: HcRuntime = {
    cwd: '/repo',
    connect: () => Promise.reject(new Error('no connect')),
    exec: () => Promise.resolve(succeededResult('{')),
  };

  const request = { terminal: 't7', processGroup: 100, signal: new AbortController().signal };

  await expect(waitForOwnership(runtime, request)).rejects.toThrow(/not JSON/u);
});

it('rejects with the abort reason when the signal aborts during the sleep', async () => {
  useFakeTimers();

  const { runtime, reads } = runtimeFor([foregroundReply(null)]);
  const controller = new AbortController();
  const request = { terminal: 't7', processGroup: 100, signal: controller.signal };

  const pending = waitForOwnership(runtime, request).then(
    () => undefined,
    (error: unknown) => error,
  );

  await vi.advanceTimersByTimeAsync(0);
  expect(reads).toHaveLength(1);

  controller.abort(new Error('the session ended'));

  await expect(pending).resolves.toEqual(new Error('the session ended'));
});

it('rejects with the abort reason when the signal aborts a running read', async () => {
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  const runtime: HcRuntime = {
    cwd: '/repo',
    connect: () => Promise.reject(new Error('no connect')),
    exec: async () => {
      reached.resolve(undefined);
      await release.promise;

      return failedResult('killed');
    },
  };

  const controller = new AbortController();

  const pending = waitForOwnership(runtime, {
    terminal: 't7',
    processGroup: 100,
    signal: controller.signal,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  await reached.promise;
  controller.abort(new Error('the session ended'));
  release.resolve(undefined);

  await expect(pending).resolves.toEqual(new Error('the session ended'));
});

it('reads nothing when the signal is already aborted', async () => {
  const { runtime, reads } = runtimeFor([foregroundReply(100)]);
  const controller = new AbortController();
  const reason = new Error('already ended');

  controller.abort(reason);

  await expect(
    waitForOwnership(runtime, { terminal: 't7', processGroup: 100, signal: controller.signal }),
  ).rejects.toBe(reason);

  expect(reads).toHaveLength(0);
});

it('rejects with the read error when the terminal read fails', async () => {
  const runtime: HcRuntime = {
    cwd: '/repo',
    connect: () => Promise.reject(new Error('no connect')),
    exec: () => Promise.resolve(failedResult('get refused')),
  };

  const request = { terminal: 't7', processGroup: 100, signal: new AbortController().signal };

  await expect(waitForOwnership(runtime, request)).rejects.toThrow(/get refused/u);
});
