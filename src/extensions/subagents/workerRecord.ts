import { dirname, join } from 'node:path';

import { readWorkerActivity } from './activity.js';
import type { WorkerActivity } from './activity.js';
import { readPendingQuestion, readReply } from './questionRecords.js';
import { findSuccessor, readEvent, readReport, readTask } from './records.js';
import type { Question, Report, Task, TaskEvent, WorkerState } from './types.js';

export interface WorkerFacts {
  events: Partial<Record<TaskEvent['kind'], TaskEvent>>;
  report: Report | undefined;
  // A pending question keeps its identity; only a saved reply adds the delivery flag.
  pendingQuestion: (Question & { replySaved?: boolean }) | undefined;
}

export interface TaskStatus {
  taskId: string;
  name: string | undefined;
  state: WorkerState;
  acceptance?: string[];
  outcome?: string;
  predecessorTaskId: string | undefined;
  predecessorName: string | undefined;
  successorTaskId: string | undefined;
  deadline: number;
  stoppedAt?: number | undefined;
  cleanupConfirmed: boolean;
  nativeSessionId: string;
  nativeSessionFile: string;
  usage: { available: false; reason: string };
  directory: string;
  activity: WorkerActivity | undefined;
  report: Report | undefined;
  pendingQuestion: WorkerFacts['pendingQuestion'];
  failure: string | undefined;
  cleanup: string | undefined;
}

// These events end the task even when no report was saved.
const taskEndedEventKinds: readonly TaskEvent['kind'][] = [
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
const deriveWorkerState = (facts: WorkerFacts, controlled = false): WorkerState => {
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

const taskOutcome = (
  events: (TaskEvent | undefined)[],
  report: Report | undefined,
  settledOrCleaned: boolean,
): string | undefined => {
  const terminal = events.find((event) => event !== undefined);

  if (terminal) {
    return terminal.kind === 'startupFailure' ? 'failure' : terminal.kind;
  }

  return report?.outcome ?? (settledOrCleaned ? 'incomplete' : undefined);
};

const predecessorName = (root: string, task: Task): string | undefined => {
  if (task.predecessorTaskId == null) {
    return undefined;
  }

  try {
    return readTask(join(root, task.predecessorTaskId)).name;
  } catch {
    return undefined;
  }
};

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
    pendingQuestion: readPendingQuestionFact(directory, taskId),
  };
};

// oxlint-disable-next-line eslint/complexity -- Status fields must reflect one consistent read of the task records.
export const taskRecordStatus = (
  directory: string,
  task: Task,
  controlled: boolean,
  entries: { directory: string; task: Task }[],
): TaskStatus => {
  const facts = readWorkerFacts(directory, task.taskId);
  const { events, report } = facts;
  const failure = events.startupFailure;
  const cleanup = events.cleanup;
  const state = deriveWorkerState(facts, controlled);

  const outcome = taskOutcome(
    [events.timeout, events.cancelled, failure],
    report,
    Boolean(events.settled ?? cleanup),
  );

  return {
    taskId: task.taskId,
    name: task.name,
    state,
    ...(task.acceptance === undefined ? {} : { acceptance: task.acceptance }),
    ...(outcome === undefined ? {} : { outcome }),
    predecessorTaskId: task.predecessorTaskId,
    predecessorName: predecessorName(dirname(directory), task),
    successorTaskId: findSuccessor(entries, task.taskId)?.taskId,
    deadline: task.deadline,
    ...(state === 'stopped'
      ? {
          stoppedAt:
            events.settled?.at ?? events.timeout?.at ?? events.cancelled?.at ?? cleanup?.at,
        }
      : {}),
    cleanupConfirmed: cleanup?.stopped === true,
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    usage: {
      available: false as const,
      reason: 'Pi reports worker usage in its own session totals.',
    },
    directory,
    activity: readWorkerActivity(directory, task.taskId),
    report,
    pendingQuestion: facts.pendingQuestion,
    failure: failure?.detail ?? (report ? undefined : events.settled?.detail),
    cleanup: cleanup?.detail,
  };
};
