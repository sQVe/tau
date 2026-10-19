import { afterEach, expect, it, vi } from 'vitest';

import * as cancellation from '../cancellation.js';
import type { Task } from '../types.js';
import { integer, readProcessStart, WorkerExitedError } from './shellIdentity.js';
import { createHandle } from './task.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const handleWithBudget = (budget: number) =>
  createHandle('/tmp/task', { cancellationBudget: 0 } as Task, performance.now() + budget);

it('accepts a positive integer process identity', () => {
  expect(integer(4242)).toBe(4242);
});

it.each([0, -1, 1.5, '12', undefined, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
  'rejects %s as a process identity',
  (value) => {
    expect(() => integer(value)).toThrow('Invalid herdr process identity');
  },
);

const recordRunClient = (output: string) => {
  const calls: { budget: number; signal: AbortSignal | undefined }[] = [];

  vi.spyOn(cancellation, 'runClient').mockImplementation(
    (_executable, _arguments, budget, options) => {
      calls.push({ budget, signal: options?.signal });

      return Promise.resolve(output);
    },
  );

  return calls;
};

it('reads a trimmed process start within the cleanup budget and signal', async () => {
  const calls = recordRunClient('Mon Jan  1 00:00:00 2024\n');
  const cleanup = { remainingBudget: () => 200, signal: new AbortController().signal };

  const start = await readProcessStart(handleWithBudget(10_000), 4242, cleanup);

  expect(start).toBe('Mon Jan  1 00:00:00 2024');
  expect(calls).toEqual([{ budget: 200, signal: cleanup.signal }]);
});

it('caps the process start read at one second even with a large cleanup budget', async () => {
  const calls = recordRunClient('start');
  const cleanup = { remainingBudget: () => 60_000, signal: new AbortController().signal };

  await readProcessStart(handleWithBudget(10_000), 4242, cleanup);

  expect(calls.map((call) => call.budget)).toEqual([1000]);
});

it('reads the process start with the handle signal when there is no cleanup budget', async () => {
  const calls = recordRunClient('start');
  const handle = handleWithBudget(10_000);

  await readProcessStart(handle, 4242);

  expect(calls).toEqual([{ budget: 1000, signal: handle.abort.signal }]);
});

it('stops the read when the cleanup signal aborts', async () => {
  const handle = handleWithBudget(10_000);
  const abort = new AbortController();

  abort.abort();

  await expect(
    readProcessStart(handle, process.pid, { remainingBudget: () => 1000, signal: abort.signal }),
  ).rejects.toThrow('aborted');
});

it('reports an exited worker when the process is gone', async () => {
  vi.spyOn(cancellation, 'runClient').mockRejectedValue(new Error('ps failed'));
  vi.spyOn(cancellation, 'processAbsent').mockReturnValue(true);

  await expect(readProcessStart(handleWithBudget(10_000), 4242)).rejects.toThrow(WorkerExitedError);
});
