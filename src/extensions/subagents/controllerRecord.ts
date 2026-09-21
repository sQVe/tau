import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { admissionDirectory, descendantReservations } from './admission.js';
import type { Handle } from './controllerTypes.js';
import { genericReportPath, readGenericReference } from './generic.js';
import { readPendingQuestion } from './questionRecords.js';
import {
  publish,
  readEvent,
  readGenericSubmission,
  readPane,
  readReport,
  readSuccessor,
  readTask,
} from './records.js';
import { harnessOf, isGenericLoadout, isPiLoadout, requireNativeTask } from './types.js';
import type { Report, Task, TaskEvent } from './types.js';
import { workerState } from './workerState.js';

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

const unconfirmedDescendants = (root: string, task: Task) => {
  try {
    const children = descendantReservations(root, task)
      .filter(
        (child) => readEvent(join(root, child.taskId), child.taskId, 'cleanup')?.stopped !== true,
      )
      .map((child) => ({ taskId: child.taskId, directory: join(root, child.taskId) }));

    return { children, evidence: undefined };
  } catch (error) {
    return {
      children: [],
      evidence: `Descendant reservation evidence unavailable; capacity may still be held. ${String(error)}`,
    };
  }
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

export interface EvidenceUnavailableInput {
  taskId: string;
  name?: string | undefined;
  evidenceError: string;
  recovery: unknown;
  cleanupDetail?: string | undefined;
  paneId?: string | undefined;
  cause?: unknown;
}

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
  if (!task.predecessorTaskId) {
    return undefined;
  }

  try {
    return readTask(join(root, task.predecessorTaskId)).name;
  } catch {
    return undefined;
  }
};

export const taskStatus = (directory: string, activeOwner?: string, enforcing = true) => {
  const task = readTask(directory);
  const report = readReport(directory, task.taskId);
  const event = (kind: TaskEvent['kind']) => readEvent(directory, task.taskId, kind);
  const failure = event('startupFailure');
  const cleanup = event('cleanup');
  const descendants = unconfirmedDescendants(dirname(directory), task);
  const state = workerState(directory, task, activeOwner, enforcing);
  const outcome = taskOutcome(
    [event('timeout'), event('cancelled'), failure],
    report,
    Boolean(event('settled') ?? cleanup),
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
    successorTaskId: readSuccessor(directory)?.successorTaskId,
    deadline: task.deadline,
    capacityHeld: cleanup?.stopped !== true,
    reservationDirectory: admissionDirectory(dirname(directory), task.tree),
    unconfirmedChildren: descendants.children,
    descendantEvidence: descendants.evidence,
    harness: harnessOf(task.loadout),
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    usage: nativeUsage(task),
    directory,
    report,
    pendingQuestion: readPendingQuestion(directory, task.taskId),
    failure: failure?.detail,
    cleanup: cleanup?.detail,
    ...(recovery ? { recovery } : {}),
  };
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
