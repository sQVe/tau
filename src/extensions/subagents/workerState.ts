import { readPendingQuestion, readReply } from './questionRecords.js';
import { readEvent, readGenericSubmission, readReport } from './records.js';
import { isGenericLoadout, taskEndedEventKinds } from './types.js';
import type { Question, Report, Task, TaskEvent, WorkerState } from './types.js';

export interface WorkerFacts {
  events: Partial<Record<TaskEvent['kind'], TaskEvent>>;
  report: Report | undefined;
  assignment: ReturnType<typeof readGenericSubmission>;
  // A pending question keeps its identity; only a saved reply adds the delivery flag.
  pendingQuestion: (Question & { replySaved?: boolean }) | undefined;
}

const factEventKinds: readonly TaskEvent['kind'][] = ['accepted', ...taskEndedEventKinds];

const readPendingQuestionFact = (directory: string, taskId: string) => {
  const question = readPendingQuestion(directory, taskId);

  if (question === undefined) {
    return undefined;
  }

  const replySaved = readReply(directory, taskId, question.questionId) !== undefined;

  return replySaved ? { ...question, replySaved: true } : question;
};

// Reads each lifecycle record once. Records can still appear between the individual reads.
export const readWorkerFacts = (directory: string, taskId: string): WorkerFacts => {
  const events: WorkerFacts['events'] = {};

  for (const kind of factEventKinds) {
    const event = readEvent(directory, taskId, kind);

    if (event) {
      events[kind] = event;
    }
  }

  return {
    events,
    report: readReport(directory, taskId),
    assignment: readGenericSubmission(directory, taskId, 'assignment'),
    pendingQuestion: readPendingQuestionFact(directory, taskId),
  };
};

// The worker's own settled.stopped never proves a stop; only the parent's cleanup record does.
// oxlint-disable-next-line eslint/complexity -- One ordered table of ownership and lifecycle rules is clearer than nested helpers.
export const deriveWorkerState = (
  facts: WorkerFacts,
  task: Task,
  controlled = false,
): WorkerState => {
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

  if (isGenericLoadout(task.loadout)) {
    return facts.assignment?.observation?.state === 'submitted' ? 'running' : 'starting';
  }

  if (facts.pendingQuestion && facts.pendingQuestion.replySaved !== true) {
    return 'awaitingReply';
  }

  return events.accepted ? 'running' : 'starting';
};
