import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { admissionDirectory, descendantReservations } from './admission.js';
import type { Handle } from './controllerTypes.js';
import { genericReportPath, readGenericReference, readGenericSubmission } from './generic.js';
import { readPendingQuestion } from './questionRecords.js';
import { publish, readEvent, readReport, readSuccessor, readTask } from './records.js';
import { harnessOf, isGenericLoadout, isPiLoadout } from './types.js';
import type { Report, Task, TaskEvent } from './types.js';

const taskOutcome = (
  events: (TaskEvent | undefined)[],
  report: Report | undefined,
  incomplete: boolean,
): string => {
  const terminal = events.find((event) => event !== undefined);

  if (terminal) {
    return terminal.kind === 'startupFailure' ? 'failure' : terminal.kind;
  }

  return report?.outcome ?? (incomplete ? 'incomplete' : 'running');
};

// Confirmed cleanup needs no warning. Only an active deadline or uncertain stop is worth stating.
const enforcementNote = (active: boolean, cleanup: TaskEvent | undefined) => {
  if (active) {
    return 'Original parent deadline remains active.';
  }

  if (cleanup?.stopped === true) {
    return undefined;
  }

  return 'No active owner in this parent. Saved evidence only; work may still be running. Check the saved pane manually. No retry or continuing enforcement is promised.';
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

export const nativeDescription = (task: Task, directory: string): string =>
  isGenericLoadout(task.loadout)
    ? `Native reference, when observed: ${join(directory, 'nativeReference.json')}.`
    : `Native session: ${task.nativeSessionId} (${task.nativeSessionFile}).`;

const nativeUsage = (task: Task) => ({
  available: false as const,
  reason: isPiLoadout(task.loadout)
    ? 'Pi reports worker usage in its own session totals.'
    : 'Native usage and model verification are unavailable through this generic interface.',
});

const stoppedStates = (settled: TaskEvent | undefined, cleanup: TaskEvent | undefined) => ({
  stopped: Boolean(settled?.stopped) || Boolean(cleanup?.stopped),
  capacityHeld: cleanup?.stopped !== true,
});

export const taskStatus = (directory: string, activeOwner?: string, enforcing = true) => {
  const task = readTask(directory);
  const report = readReport(directory, task.taskId);
  const event = (kind: TaskEvent['kind']) => readEvent(directory, task.taskId, kind);
  const timeout = event('timeout');
  const cancelled = event('cancelled');
  const failure = event('startupFailure');
  const settled = event('settled');
  const cleanup = event('cleanup');
  const descendants = unconfirmedDescendants(dirname(directory), task);
  const owned = enforcing && activeOwner === task.ownerId;
  const terminal = cleanup ?? timeout ?? cancelled;
  const active = owned && !terminal;
  const outcome = taskOutcome([timeout, cancelled, failure], report, Boolean(settled) || !active);
  const states = stoppedStates(settled, cleanup);

  return {
    taskId: task.taskId,
    name: task.name,
    predecessorTaskId: task.predecessorTaskId,
    successorTaskId: readSuccessor(directory)?.successorTaskId,
    outcome,
    ready: Boolean(event('ready')),
    accepted: Boolean(event('accepted')),
    reportAccepted: Boolean(report),
    ownedByThisParent: activeOwner === task.ownerId,
    deadlineActive: active,
    stopped: states.stopped,
    deadline: task.deadline,
    capacityHeld: states.capacityHeld,
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
    enforcement: enforcementNote(active, cleanup),
  };
};

export const genericStatus = (directory: string, task: Task, handle?: Handle) => {
  if (!isGenericLoadout(task.loadout)) {
    return {};
  }

  return {
    // Keep the generic harness separate from the native kind name in status.
    harness: 'generic' as const,
    nativeKind: task.loadout.kind,
    nativeState: handle?.nativeState ?? 'unknown',
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
