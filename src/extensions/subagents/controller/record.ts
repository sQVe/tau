import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Value } from 'typebox/value';

import type { OwnedWorker } from '../cancellation.js';
import { genericReportPath, readGenericReference } from '../generic.js';
import { readPendingQuestion, readReply } from '../questionRecords.js';
import {
  findSuccessor,
  publish,
  readEvent,
  readGenericSubmission,
  readPane,
  readOptionalRecord,
  readReport,
  readTask,
  readTasks,
} from '../records.js';
import {
  harnessOf,
  isGenericLoadout,
  isPiLoadout,
  ownedWorkerSchema,
  requireNativeTask,
} from '../types.js';
import type { Report, Task, TaskEvent } from '../types.js';
import { workerState } from '../workerState.js';
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

  const generic = isGenericLoadout(task.loadout);

  if (value.kind !== (generic ? 'generic' : 'pi')) {
    throw new Error('Saved worker kind does not match the task.');
  }

  if (value.kind === 'pi' && value.token !== task.nativeSessionFile) {
    throw new Error('Saved worker session does not match the task.');
  }

  const reference = value.nativeReference ?? readGenericReference(directory, task.taskId);

  return reference ? { ...value, nativeReference: reference } : value;
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
  const base = { ...(paneId === undefined ? {} : { paneId }), directory };

  if (isPiLoadout(task.loadout)) {
    return { ...base, nativeSessionFile: requireNativeTask(task).nativeSessionFile };
  }

  const reference = readGenericReference(directory, task.taskId);

  return { ...base, ...(reference ? { nativeReference: reference } : {}) };
};

// Evidence notices read only handle memory; a corrupt record cannot build this recovery hint.
export const handleRecovery = (handle: Handle) => {
  const base = {
    ...(handle.paneId === undefined ? {} : { paneId: handle.paneId }),
    directory: handle.directory,
  };

  if (isPiLoadout(handle.task.loadout)) {
    return { ...base, nativeSessionFile: requireNativeTask(handle.task).nativeSessionFile };
  }

  const reference = handle.owned?.nativeReference;

  return { ...base, ...(reference === undefined ? {} : { nativeReference: reference }) };
};

// Without a handle, recovery falls back to the task directory and the saved Pi session path.
export const savedRecovery = (task: Task | undefined, directory: string) => {
  if (task && isPiLoadout(task.loadout)) {
    return { directory, nativeSessionFile: requireNativeTask(task).nativeSessionFile };
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

const nativeUsage = (task: Task) => ({
  available: false as const,
  reason: isPiLoadout(task.loadout)
    ? 'Pi reports worker usage in its own session totals.'
    : 'Native usage and model verification are unavailable through this generic interface.',
});

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

// A pending question keeps its identity; only a saved reply adds the delivery flag.
const pendingQuestionStatus = (directory: string, taskId: string) => {
  const question = readPendingQuestion(directory, taskId);

  if (question === undefined) {
    return undefined;
  }

  const replySaved = readReply(directory, taskId, question.questionId) !== undefined;

  return replySaved ? { ...question, replySaved: true } : question;
};

// oxlint-disable-next-line eslint/complexity -- Status fields must reflect one consistent read of the task records.
export const taskRecordStatus = (directory: string, task: Task, controlled = false) => {
  const report = readReport(directory, task.taskId);
  const event = (kind: TaskEvent['kind']) => readEvent(directory, task.taskId, kind);
  const failure = event('startupFailure');
  const cleanup = event('cleanup');
  const settled = event('settled');
  const state = workerState(directory, task, controlled);

  const outcome = taskOutcome(
    [event('timeout'), event('cancelled'), failure],
    report,
    Boolean(event('settled') ?? cleanup),
  );

  const needsRecovery = state === 'cleanupUnconfirmed' || state === 'notOwned';
  const pendingQuestion = pendingQuestionStatus(directory, task.taskId);
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
      ? { stoppedAt: settled?.at ?? event('timeout')?.at ?? event('cancelled')?.at ?? cleanup?.at }
      : {}),
    cleanupConfirmed: cleanup?.stopped === true,
    harness: harnessOf(task.loadout),
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    usage: nativeUsage(task),
    directory,
    report,
    pendingQuestion,
    failure: failure?.detail,
    cleanup: cleanup?.detail,
    ...(recovery ? { recovery } : {}),
  };
};

export const taskStatus = (directory: string, controlled = false) => {
  const task = readTask(directory);

  return taskRecordStatus(directory, task, controlled);
};

export const genericStatus = (
  directory: string,
  task: Task,
  handle?: Handle,
  ownedLive = false,
) => {
  if (!isGenericLoadout(task.loadout)) {
    return {};
  }

  return {
    // Keep the generic harness separate from the native kind name in status.
    harness: 'generic' as const,
    nativeKind: task.loadout.kind,
    ...(ownedLive && handle?.nativeState !== undefined ? { nativeState: handle.nativeState } : {}),
    observationIssue: handle?.observationIssue,
    nativeReference: readGenericReference(directory, task.taskId),
    nativeConfiguration: task.loadout,
    requestedModel: task.loadout.requestedModel,
    observedModel: null,
    modelVerification:
      'Unavailable. Native arguments record a request, not proof of the model used.',
    reportPath: genericReportPath(task),
    assignment: readGenericSubmission(directory, task.taskId, 'assignment'),
    safety:
      'Native controls; Tau does not certify runtime enforcement. Approval dialogs require user action.',
  };
};

export const recordNativeIssue = (handle: Handle, filename: string, error: unknown): void => {
  const detail = String(error).slice(0, 4000);

  handle.observationIssue = detail;

  try {
    if (!existsSync(join(handle.directory, filename))) {
      publish(handle.directory, filename, { taskId: handle.task.taskId, detail });
    }
  } catch (recordError) {
    handle.recordErrors.push(String(recordError));
  }
};

// Absence evidence proves no live process remains; it does not prove the start never ran.
export const cleanupDetail = (handle: Handle, stopped: boolean): string => {
  const pane = handle.paneId ?? 'none';

  if (handle.startError !== undefined && handle.workerNeverStarted) {
    return `Native startup was rejected by herdr absence evidence; a worker may have started briefly and exited. Pane ${pane} is left as placed.`;
  }

  return stopped
    ? `No worker process was ever started for this task. Pane ${pane} is left as placed.`
    : `Cleanup unconfirmed. Check pane ${handle.paneId ?? 'unknown'} manually. No automatic retry.`;
};
