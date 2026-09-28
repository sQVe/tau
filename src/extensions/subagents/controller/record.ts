import { dirname, join } from 'node:path';

import { Value } from 'typebox/value';

import type { OwnedWorker } from '../cancellation.js';
import { readPendingQuestion, readReply } from '../questionRecords.js';
import {
  findSuccessor,
  readEvent,
  readPane,
  readOptionalRecord,
  readReport,
  readTask,
  readTasks,
} from '../records.js';
import { ownedWorkerSchema } from '../types.js';
import type { Report, Task, TaskEvent } from '../types.js';
import { deriveWorkerState, taskEndedEventKinds } from '../workerState.js';
import type { WorkerFacts } from '../workerState.js';
import type { Handle } from './types.js';

export interface EvidenceUnavailableInput {
  taskId: string;
  name?: string | undefined;
  evidenceError: string;
  recovery: unknown;
  cleanupDetail?: string | undefined;
  paneId?: string | undefined;
  cause?: unknown;
}

export const readOwnedWorker = (directory: string, task: Task): OwnedWorker => {
  const value = readOptionalRecord(directory, 'owned.json');

  if (value === undefined) {
    throw new Error('No saved worker ownership.');
  }

  if (!Value.Check(ownedWorkerSchema, value)) {
    throw new Error('Invalid saved worker ownership.');
  }

  if (value.token !== task.nativeSessionFile) {
    throw new Error('Saved worker session does not match the task.');
  }

  return value;
};

// Without a report, terminal event, or cleanup record there is no outcome to claim.
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

const taskRecovery = (task: Task, directory: string) => {
  const paneId = readPane(directory);

  return {
    ...(paneId === undefined ? {} : { paneId }),
    directory,
    nativeSessionFile: task.nativeSessionFile,
  };
};

// Evidence notices read only handle memory; a corrupt record cannot build this recovery hint.
export const handleRecovery = (handle: Handle) => ({
  ...(handle.identity.paneId === undefined ? {} : { paneId: handle.identity.paneId }),
  directory: handle.directory,
  nativeSessionFile: handle.task.nativeSessionFile,
});

// Without a handle, recovery falls back to the task directory and the saved Pi session path.
export const savedRecovery = (task: Task | undefined, directory: string) => {
  if (task) {
    return { directory, nativeSessionFile: task.nativeSessionFile };
  }

  return { directory };
};

// The message stays free of record paths; recovery carries them for manual cleanup.
export class EvidenceUnavailableError extends Error {
  readonly taskId: string;
  readonly taskName: string | undefined;
  readonly evidenceError: string;
  readonly recovery: unknown;

  constructor(input: EvidenceUnavailableInput) {
    super(
      `Worker ${input.taskId}: saved evidence is unavailable: ${input.evidenceError}. ${input.cleanupDetail ?? 'Cleanup unconfirmed.'} Check pane ${input.paneId ?? 'unknown'} manually.`,
      { cause: input.cause },
    );

    this.name = 'EvidenceUnavailableError';
    this.taskId = input.taskId;
    this.taskName = input.name;
    this.evidenceError = input.evidenceError;
    this.recovery = input.recovery;
  }
}

// A missing or unreadable predecessor must not fail the status; the renderer falls back to the
// short task ID when the name is absent.
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
export const taskRecordStatus = (directory: string, task: Task, controlled = false) => {
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

  const needsRecovery = state === 'cleanupUnconfirmed' || state === 'notOwned';
  const recovery = needsRecovery ? taskRecovery(task, directory) : undefined;

  return {
    taskId: task.taskId,
    name: task.name,
    state,
    ...(outcome === undefined ? {} : { outcome }),
    predecessorTaskId: task.predecessorTaskId,
    predecessorName: predecessorName(dirname(directory), task),
    // ponytail: full scan (~10 ms/100 records in review); index successors once per scan if status calls become hot.
    successorTaskId: findSuccessor(readTasks(dirname(directory)), task.taskId)?.taskId,
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
    report,
    pendingQuestion: facts.pendingQuestion,
    failure: failure?.detail,
    cleanup: cleanup?.detail,
    ...(recovery ? { recovery } : {}),
  };
};

export const taskStatus = (directory: string, controlled = false) => {
  const task = readTask(directory);

  return taskRecordStatus(directory, task, controlled);
};

// Absence evidence proves no live process remains; it does not prove the start never ran.
export const cleanupDetail = (handle: Handle, stopped: boolean): string => {
  const pane = handle.identity.paneId ?? 'none';

  if (handle.startup.error !== undefined && handle.startup.neverStarted) {
    return `Native startup was rejected by herdr absence evidence; a worker may have started briefly and exited. Pane ${pane} is left as placed.`;
  }

  return stopped
    ? `No worker process was ever started for this task. Pane ${pane} is left as placed.`
    : `Cleanup unconfirmed. Check pane ${handle.identity.paneId ?? 'unknown'} manually. No automatic retry.`;
};
