import { readEvent, readReport } from '../records.js';
import { replyClosedEventKinds } from '../types.js';
import type { Handle } from './types.js';

interface LaunchTiming {
  createdAt: number;
  deadline: number;
  expires: number;
  cancellationBudget: number;
  monotonicDeadline: number;
}

const nanosecondsPerMillisecond = 1_000_000;
const maximumCancellationBudget = 5000;
// Cleanup gets a quarter of a short task's time.
const cancellationShare = 4;

// A rename is cosmetic, so it gets a short deadline of its own.
export const renameBudget = 2_000;

export const monotonicNow = (): number =>
  Number(process.hrtime.bigint()) / nanosecondsPerMillisecond;

// One remainder for every budget question; two clocks disagree within a millisecond.
export const remainingLaunchBudget = (timing: {
  expires: number;
  cancellationBudget: number;
}): number => Math.floor(timing.expires - timing.cancellationBudget - performance.now());

export const remainingWorkBudget = (handle: Handle): number =>
  remainingLaunchBudget({
    expires: handle.expires,
    cancellationBudget: handle.task.cancellationBudget,
  });

export const remainingCleanupBudget = (handle: Handle): number =>
  Math.floor(Math.min(handle.task.cancellationBudget, handle.expires - performance.now()));

export const workBudget = (handle: Handle, maximum = 30_000): number => {
  handle.abort.signal.throwIfAborted();
  const remaining = remainingWorkBudget(handle);

  if (remaining <= 0) {
    throw new Error('The original worker startup budget expired.');
  }

  return Math.min(maximum, remaining);
};

export const ensureReplyActive = (handle: Handle): void => {
  workBudget(handle);
  const { directory, task } = handle;

  const missingAcceptance = !readEvent(directory, task.taskId, 'accepted');

  const ended =
    replyClosedEventKinds.some((kind) => readEvent(directory, task.taskId, kind)) ||
    readReport(directory, task.taskId) !== undefined;

  if (missingAcceptance || ended) {
    throw new Error('Worker task is inactive.');
  }
};

export const launchTiming = (
  timeout: number,
  startedAt?: { wall: number; monotonic: number },
): LaunchTiming => {
  const createdAt = startedAt?.wall ?? Date.now();
  const expires = (startedAt?.monotonic ?? performance.now()) + timeout;

  const cancellationBudget = Math.min(
    maximumCancellationBudget,
    Math.floor(timeout / cancellationShare),
  );

  if (!Number.isFinite(expires) || performance.now() >= expires - cancellationBudget) {
    throw new Error('The original task work budget expired during loadout resolution.');
  }

  return {
    createdAt,
    deadline: createdAt + timeout,
    expires,
    cancellationBudget,
    monotonicDeadline: monotonicNow() + expires - performance.now(),
  };
};
