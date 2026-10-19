import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { acceptReport, recordEvent } from '../records.js';
import type { Task, TaskEvent } from '../types.js';
import {
  ensureReplyActive,
  launchTiming,
  monotonicNow,
  remainingCleanupBudget,
  workBudget,
} from './budget.js';
import { createHandle } from './task.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const handleFor = (remaining: number, cancellationBudget = 0) => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-budget-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const task = { taskId: 'task', cancellationBudget } as Task;

  return createHandle(directory, task, performance.now() + cancellationBudget + remaining);
};

it('bounds work by the time left before the cleanup reserve', () => {
  expect(workBudget(handleFor(500, 100))).toBe(500);
  expect(workBudget(handleFor(60_000), 1000)).toBe(1000);
});

it('refuses work when no time is left', () => {
  expect(() => workBudget(handleFor(0, 100))).toThrow('budget expired');
  expect(() => workBudget(handleFor(-5, 100))).toThrow('budget expired');
});

it('refuses work after the handle was aborted', () => {
  const handle = handleFor(1000);

  handle.abort.abort();

  expect(() => workBudget(handle)).toThrow('aborted');
});

const acceptedHandle = () => {
  const handle = handleFor(1000);

  recordEvent(handle.directory, 'task', 'accepted', 'Accepted.');

  return handle;
};

it('lets a reply reach an accepted, active worker', () => {
  expect(() => {
    ensureReplyActive(acceptedHandle());
  }).not.toThrow();
});

it('refuses a reply before the worker accepted the task', () => {
  expect(() => {
    ensureReplyActive(handleFor(1000));
  }).toThrow('inactive');
});

it.each(['settled', 'startupFailure', 'cleanup', 'cancelled', 'timeout'] as TaskEvent['kind'][])(
  'refuses a reply after a %s event',
  (kind) => {
    const handle = acceptedHandle();

    recordEvent(handle.directory, 'task', kind, 'Ended.');

    expect(() => {
      ensureReplyActive(handle);
    }).toThrow('inactive');
  },
);

it('refuses a reply after the worker reported', () => {
  const handle = acceptedHandle();

  acceptReport(handle.directory, 'task', {
    taskId: 'task',
    outcome: 'success',
    summary: 'Finished.',
    evidence: ['Checked.'],
  });

  expect(() => {
    ensureReplyActive(handle);
  }).toThrow('inactive');
});

it('refuses a reply for an active worker whose time ran out', () => {
  const handle = acceptedHandle();

  vi.advanceTimersByTime(2000);

  expect(() => {
    ensureReplyActive(handle);
  }).toThrow('budget expired');
});

it('refuses a launch with no work time left', () => {
  expect(() => launchTiming(0)).toThrow('budget expired');
});

it('reserves a quarter of a short launch for cleanup', () => {
  const timing = launchTiming(1000);

  expect(timing.cancellationBudget).toBe(250);
  expect(timing.deadline - timing.createdAt).toBe(1000);
});

it('places the monotonic deadline one timeout ahead of now', () => {
  vi.advanceTimersByTime(5000);

  const timing = launchTiming(10_000);

  expect(timing.monotonicDeadline - monotonicNow()).toBeGreaterThan(9000);
  expect(timing.monotonicDeadline - monotonicNow()).toBeLessThanOrEqual(10_000);
});

it('bounds cleanup by the time left before the deadline', () => {
  vi.advanceTimersByTime(1000);

  expect(remainingCleanupBudget(handleFor(0, 400))).toBe(400);
  expect(remainingCleanupBudget(handleFor(-350, 400))).toBe(50);
});
