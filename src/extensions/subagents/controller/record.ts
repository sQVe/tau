import { dirname, join } from 'node:path';

import type { Static } from 'typebox';
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

// Pi ownership before version 2 described a shell that ran Pi.
const isRetiredPiOwnership = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null || 'version' in value) {
    return false;
  }

  return 'kind' in value && value.kind === 'pi';
};

// A Pi worker is its pane's own process.
const isOwnedWorker = (value: unknown): value is Static<typeof ownedWorkerSchema> => {
  if (!Value.Check(ownedWorkerSchema, value)) {
    return false;
  }

  return value.shellPid === value.processId;
};

const checkOwnedWorker = (value: unknown): Static<typeof ownedWorkerSchema> => {
  if (value === undefined) {
    throw new Error('No saved worker ownership.');
  }

  if (isRetiredPiOwnership(value)) {
    throw new Error('Saved worker ownership is in a retired format; start a fresh task instead.');
  }

  if (!isOwnedWorker(value)) {
    throw new Error('Invalid saved worker ownership.');
  }

  return value;
};

export const readOwnedWorker = (directory: string, task: Task): OwnedWorker => {
  const value = checkOwnedWorker(readOptionalRecord(directory, 'owned.json'));

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
export const taskRecordStatus = (
  directory: string,
  task: Task,
  controlled = false,
  // A caller that builds many statuses passes one snapshot so each status skips its own scan.
  entries: { directory: string; task: Task }[] = readTasks(dirname(directory)),
) => {
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
