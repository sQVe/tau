import { monotonicNow } from '../admission.js';
import { readEvent, readReport } from '../records.js';
import { isGenericLoadout, replyClosedEventKinds } from '../types.js';
import type { Handle } from './types.js';

// One remainder for every budget question; two clocks disagree within a millisecond.
export const remainingLaunchBudget = (timing: { expires: number; cancellationBudget: number }) =>
  Math.floor(timing.expires - timing.cancellationBudget - performance.now());

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
  const missingPiAcceptance =
    !isGenericLoadout(task.loadout) && !readEvent(directory, task.taskId, 'accepted');
  const ended =
    replyClosedEventKinds.some((kind) => readEvent(directory, task.taskId, kind)) ||
    readReport(directory, task.taskId);

  if (missingPiAcceptance || ended) {
    throw new Error('Worker task is inactive.');
  }
};

export const launchTiming = (timeout: number, startedAt?: { wall: number; monotonic: number }) => {
  const createdAt = startedAt?.wall ?? Date.now();
  const expires = (startedAt?.monotonic ?? performance.now()) + timeout;
  const cancellationBudget = Math.min(5000, Math.floor(timeout / 4));

  if (!Number.isFinite(expires) || performance.now() >= expires - cancellationBudget) {
    throw new Error('The original task work budget expired during loadout resolution.');
  }

  return {
    createdAt,
    deadline: createdAt + timeout,
    expires,
    cancellationBudget,
  };
};

export const boundedTiming = (timing: ReturnType<typeof launchTiming>) => ({
  ...timing,
  monotonicDeadline: monotonicNow() + timing.expires - performance.now(),
});
