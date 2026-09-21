import { readPendingQuestion, readReply } from './questionRecords.js';
import { readEvent, readGenericSubmission, readReport } from './records.js';
import { isGenericLoadout } from './types.js';
import type { Task, TaskEvent, WorkerState } from './types.js';

// The worker's own settled.stopped never proves a stop; only the parent's cleanup record does.
// oxlint-disable-next-line eslint/complexity -- One ordered table of ownership and lifecycle rules is clearer than nested helpers.
export const workerState = (
  directory: string,
  task: Task,
  activeOwner: string | undefined,
  enforcing: boolean,
): WorkerState => {
  const event = (kind: TaskEvent['kind']) => readEvent(directory, task.taskId, kind);
  const cleanup = event('cleanup');
  if (cleanup?.stopped === true) {
    return 'stopped';
  }

  const stopRecords = [cleanup, event('timeout'), event('cancelled')];
  if (stopRecords.some((record) => record?.stopped === false)) {
    return 'cleanupUnconfirmed';
  }

  const owned = activeOwner === task.ownerId;
  if (owned && (!enforcing || Boolean(event('stopping')))) {
    return 'stopping';
  }
  if (!owned) {
    const terminal = (
      ['settled', 'startupFailure', 'timeout', 'cancelled', 'stopping'] as const
    ).some((kind) => event(kind));

    return terminal ? 'cleanupUnconfirmed' : 'notOwned';
  }
  if (readReport(directory, task.taskId)) {
    return 'reported';
  }

  if (isGenericLoadout(task.loadout)) {
    return readGenericSubmission(directory, task.taskId, 'assignment')?.observation?.state ===
      'submitted'
      ? 'running'
      : 'starting';
  }
  const question = readPendingQuestion(directory, task.taskId);
  if (question && !readReply(directory, task.taskId, question.questionId)) {
    return 'awaitingReply';
  }

  return event('accepted') ? 'running' : 'starting';
};
