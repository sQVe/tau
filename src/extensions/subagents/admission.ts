import { readEvent, readReport } from './records.js';
import { taskEndedEventKinds } from './types.js';
import type { Task } from './types.js';

export const monotonicNow = (): number => Number(process.hrtime.bigint()) / 1_000_000;

export const taskEnded = (directory: string, task: Task): boolean =>
  taskEndedEventKinds.some((kind) => readEvent(directory, task.taskId, kind)) ||
  Boolean(readReport(directory, task.taskId));

export const workerCapacity = (): number => {
  // oxlint-disable-next-line node/no-process-env -- Each controller reads its capacity once at construction.
  const capacity = Number(process.env.TAU_SUBAGENT_CAP ?? 4);

  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) {
    throw new Error('TAU_SUBAGENT_CAP must be an integer from 1 to 256.');
  }

  return capacity;
};
