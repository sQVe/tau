import type { Question, Report, TaskEvent, WorkerState } from './types.js';

// Decides worker state from facts the caller read. tests/structure.test.ts keeps this module pure.

export interface WorkerFacts {
  events: Partial<Record<TaskEvent['kind'], TaskEvent>>;
  report: Report | undefined;
  // A pending question keeps its identity; only a saved reply adds the delivery flag.
  pendingQuestion: (Question & { replySaved?: boolean }) | undefined;
}

// These events end the task even when no report was saved.
export const taskEndedEventKinds: readonly TaskEvent['kind'][] = [
  'cleanup',
  'cancelled',
  'timeout',
  'startupFailure',
  'parentClosed',
  'settled',
  'stopping',
];

// The worker's own settled.stopped never proves a stop; only the parent's cleanup record does.
// oxlint-disable-next-line eslint/complexity -- One ordered table of ownership and lifecycle rules is clearer than nested helpers.
export const deriveWorkerState = (facts: WorkerFacts, controlled = false): WorkerState => {
  const { events } = facts;

  if (events.cleanup?.stopped === true) {
    return 'stopped';
  }

  const stopRecords = [events.cleanup, events.timeout, events.cancelled];

  if (stopRecords.some((record) => record?.stopped === false)) {
    return 'cleanupUnconfirmed';
  }

  if (controlled && events.stopping) {
    return 'stopping';
  }

  if (!controlled) {
    const terminal = taskEndedEventKinds.some(
      (kind) => kind !== 'parentClosed' && events[kind] !== undefined,
    );

    return terminal || facts.report !== undefined ? 'cleanupUnconfirmed' : 'notOwned';
  }

  if (facts.report) {
    return 'reported';
  }

  if (facts.pendingQuestion && facts.pendingQuestion.replySaved !== true) {
    return 'awaitingReply';
  }

  return events.accepted ? 'running' : 'starting';
};
