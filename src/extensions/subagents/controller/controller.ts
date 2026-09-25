import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext, SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

import { parseModelReference } from '../../../delegateModel/index.js';
import { errorMessage, isMissingFile } from '../../../errors/index.js';
import { readWorkerActivity } from '../activity.js';
import { processAbsent } from '../cancellation.js';
import { refuseLiveNativeWriter } from '../continuations.js';
import { submitGenericText, genericPrompt, acceptGenericReport } from '../generic.js';
import { authorizeHistoryTask } from '../history.js';
import { validateSavedLoadout } from '../loadout.js';
import { allocateName, nameSuffix } from '../names.js';
import { validateNative } from '../native.js';
import { WorkerPlacement } from '../placement.js';
import { modelEvidenceNotice, modelStatus } from '../presentation.js';
import type { WorkerNotice } from '../presentation.js';
import {
  acceptReply,
  readAcknowledgement,
  readPendingQuestion,
  readQuestion,
  readReply,
} from '../questionRecords.js';
import {
  readEvent,
  readGenericSubmission,
  readTask,
  readTasks,
  namePrefix,
  publish,
  validateTask,
  recordEvent,
} from '../records.js';
import { resolveTerminal, text, requireObject, result } from '../terminal.js';
import type { TerminalCall } from '../terminal.js';
import { isGenericLoadout, isPiLoadout, isTaskId } from '../types.js';
import type { GenericLoadout, ReplyDelivery, SubmissionState, Task } from '../types.js';
import type { WorkerWidgetRow } from '../widget.js';
import {
  ensureReplyActive,
  workBudget,
  launchTiming,
  remainingCleanupBudget,
  remainingLaunchBudget,
  remainingWorkBudget,
} from './budget.js';
import {
  agentPromptArguments,
  herdrClient,
  inspectWorker,
  waitForPiIdentity,
  isHerdrError,
  prepareTaskDirectory,
  verifyRejectedStart,
  waitForWorkerReadiness,
  waitForWorkerExit,
  workerArguments,
} from './inspect.js';
import type { HerdrClient } from './inspect.js';
import { checkHandoff, nativeReference, requireUnclaimed } from './launchSupport.js';
import type { FollowUpPreparation, LaunchInput } from './launchSupport.js';
import {
  EvidenceUnavailableError,
  genericStatus,
  handleRecovery,
  savedRecovery,
  taskStatus,
  taskRecordStatus,
  cleanupDetail,
  recordNativeIssue,
  readOwnedWorker,
} from './record.js';
import {
  waitForShell,
  integer,
  isBareShell,
  readProcessStart,
  WorkerExitedError,
} from './shellIdentity.js';
import type { InspectionBudget } from './shellIdentity.js';
import { closeUnstartedPane, stopOwnedWorker } from './stop.js';
import type { Handle } from './types.js';

interface PiReplyRequest {
  directory: string;
  handle: Handle;
  questionId: string;
  answer: { replyId: string };
  value: unknown;
}

interface StatusFailureRequest {
  taskId: string;
  directory: string;
  handle: Handle | undefined;
  task: Task | undefined;
  error: unknown;
}

interface LaunchTaskPlan {
  taskId: string;
  directory: string;
  createdAt: number;
  deadline: number;
  cancellationBudget: number;
  monotonicDeadline: number;
  source?: FollowUpPreparation;
}

interface CleanupOutcomeRequest {
  handle: Handle;
  reason: 'timeout' | 'cancelled' | 'completion' | 'failure';
  failureDetail: string;
  detail: string;
  stopped: boolean;
  record: (operation: () => void) => void;
}

const workerCapacity = (): number => {
  // oxlint-disable-next-line node/no-process-env -- Each controller reads its capacity once at construction.
  const capacity = Number(process.env.TAU_SUBAGENT_CAP ?? 4);

  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) {
    throw new Error('TAU_SUBAGENT_CAP must be an integer from 1 to 256.');
  }

  return capacity;
};

const paneTitle = (task: Task): string => {
  const harness = isGenericLoadout(task.loadout) ? task.loadout.kind : task.loadout.harness;
  const model = isPiLoadout(task.loadout) ? parseModelReference(task.loadout.model)?.id : undefined;
  const identity = [harness, model].filter((value): value is string => value !== undefined);
  const details = identity.map((value) => value.replace(/[^a-zA-Z0-9._-]/g, '-'));

  return `${task.name ?? 'worker'} (${details.join(' / ')})`;
};

// The reply is saved before this read. A corrupt acknowledgement record must not make a saved reply
// look failed, because a failure would invite a resend of the same identity.
const replyAcknowledged = (directory: string, taskId: string, questionId: string): boolean => {
  try {
    return Boolean(readAcknowledgement(directory, taskId, questionId));
  } catch {
    return false;
  }
};

const acceptedReply = (directory: string, task: Task, questionId: string) => ({
  replyAccepted: true,
  name: task.name,
  workerAcknowledged: replyAcknowledged(directory, task.taskId, questionId),
  delivery: 'notResent' as const,
});

const requireGenericReplyShape = (answer: {
  questionId?: string;
  replyId: string;
  reply: string;
}): void => {
  const hasStructuredQuestion = answer.questionId !== undefined;
  const reusedReplyId = answer.replyId === 'assignment';
  const invalidText = !answer.reply.trim() || answer.reply.length > 32_000;

  if (hasStructuredQuestion || reusedReplyId || invalidText) {
    throw new Error(
      'Generic replies use a unique replyId and plain text, without a structured questionId.',
    );
  }
};

// A caller asked for a task it may not read; this is a refusal, never unreadable evidence.
class TaskAccessError extends Error {
  override name = 'TaskAccessError';
}

const deliveryFromSubmission = (
  state: SubmissionState | undefined,
): Exclude<ReplyDelivery, 'notResent'> => {
  if (state === 'submitted') {
    return 'sent';
  }

  if (state === 'not-delivered') {
    return 'notDelivered';
  }

  return 'uncertain';
};

// A saved reply identity is never sent again; different text under the same identity is a conflict.
const repeatedGenericReply = (
  directory: string,
  task: Task,
  answer: { replyId: string; reply: string },
) => {
  const saved = readGenericSubmission(directory, task.taskId, answer.replyId);

  if (!saved) {
    return undefined;
  }

  if (saved.intent.text !== answer.reply) {
    throw new Error('Conflicting native submission identity.');
  }

  // Only a submitted reply is "already sent"; a repeat of an undelivered or uncertain one keeps
  // that outcome, so the model never reads a failed delivery as accepted.
  const state = saved.observation?.state;
  const delivery = state === 'submitted' ? ('notResent' as const) : deliveryFromSubmission(state);

  return { replyAccepted: true as const, name: task.name, delivery };
};

const readWidgetStatus = (directory: string, task: Task, controlled: boolean) => {
  try {
    return taskRecordStatus(directory, task, controlled);
  } catch {
    return undefined;
  }
};

const currentActivity = (activity: ReturnType<typeof readWorkerActivity>, now: number): boolean =>
  activity !== undefined && activity.updatedAt <= now && now - activity.updatedAt < 60_000;

const phaseActivityText = (
  activity: ReturnType<typeof readWorkerActivity>,
  isCurrent: boolean,
): string | undefined => {
  if (activity?.description === undefined) {
    return undefined;
  }

  if (isCurrent) {
    return activity.description;
  }

  return `${activity.description} (stale)`;
};

const genericActivity = (handle: Handle | undefined): string => {
  if (handle?.observationIssue != null && handle.observationIssue !== '') {
    return 'herdr observation unavailable';
  }

  return `herdr ${handle?.nativeState ?? 'unavailable'}`;
};

const widgetActivity = (
  task: Task,
  activity: ReturnType<typeof readWorkerActivity>,
  handle: Handle | undefined,
  isCurrent: boolean,
  showPhase: boolean,
): string => {
  const phase = showPhase ? phaseActivityText(activity, isCurrent) : undefined;

  if (phase !== undefined) {
    return phase;
  }

  if (isCurrent && activity?.label != null && activity.label !== '') {
    return activity.label;
  }

  if (isGenericLoadout(task.loadout)) {
    return genericActivity(handle);
  }

  return activity ? 'Pi activity stale' : 'Pi activity unavailable';
};

const widgetModel = (
  task: Task,
  activity: ReturnType<typeof readWorkerActivity>,
  isCurrent: boolean,
): string => {
  if (isGenericLoadout(task.loadout)) {
    return task.loadout.requestedModel != null
      ? `requested ${task.loadout.requestedModel} · observed unavailable`
      : 'model unavailable';
  }

  if (isCurrent && activity?.model != null && activity.model !== '') {
    return `Pi-selected ${activity.model} · requested ${task.loadout.model}`;
  }

  return `requested ${task.loadout.model} · observed unavailable`;
};

const widgetUsage = (
  task: Task,
  activity: ReturnType<typeof readWorkerActivity>,
): WorkerWidgetRow['usage'] => {
  if (activity?.usage) {
    return {
      available: true,
      label: `Pi active branch: ${activity.usage.input} input · cache read ${activity.usage.cacheRead} · cache write ${activity.usage.cacheWrite} · ${activity.usage.output} output`,
    };
  }

  return {
    available: false,
    reason: isGenericLoadout(task.loadout)
      ? 'herdr did not expose usage'
      : 'Pi session usage was not recorded',
  };
};

const widgetQuestion = (
  status: ReturnType<typeof readWidgetStatus>,
): Pick<WorkerWidgetRow, 'question' | 'questionId'> => {
  const question = status?.pendingQuestion;

  if (question?.question == null) {
    return {};
  }

  if ('replySaved' in question && question.replySaved) {
    return {};
  }

  return { question: question.question, questionId: question.questionId };
};

const widgetRecordFields = (
  status: ReturnType<typeof readWidgetStatus>,
): Pick<
  WorkerWidgetRow,
  | 'outcome'
  | 'question'
  | 'questionId'
  | 'terminal'
  | 'cleanup'
  | 'cleanupConfirmed'
  | 'stoppedAt'
  | 'report'
> => {
  const fields: Pick<
    WorkerWidgetRow,
    | 'outcome'
    | 'question'
    | 'questionId'
    | 'terminal'
    | 'cleanup'
    | 'cleanupConfirmed'
    | 'stoppedAt'
    | 'report'
  > = { ...widgetQuestion(status) };

  if (status?.report) {
    fields.outcome = status.report.outcome;
    fields.report = { summary: status.report.summary, evidence: status.report.evidence };
  }

  if (status?.outcome != null) {
    fields.terminal = status.outcome;
  }

  if (status?.cleanup !== undefined) {
    fields.cleanup = status.cleanup;
    fields.cleanupConfirmed = status.cleanupConfirmed;
  }

  if (status?.state === 'stopped' && status.stoppedAt !== undefined) {
    fields.stoppedAt = status.stoppedAt;
  }

  return fields;
};

const widgetSafety = (task: Task): string =>
  isGenericLoadout(task.loadout)
    ? 'native-controls, not Tau-certified'
    : 'Pi trusted tools + verified safety';

const widgetManualCleanup = (status: ReturnType<typeof readWidgetStatus>): string => {
  const needsManualCleanup = status?.state === 'cleanupUnconfirmed' || status?.state === 'notOwned';

  if (!needsManualCleanup) {
    return '';
  }

  return `manual cleanup ${status.recovery?.paneId ?? status.recovery?.directory ?? 'inspect status'}`;
};

const widgetEvidencePath = (
  status: ReturnType<typeof readWidgetStatus>,
  directory: string,
): string => {
  if (status?.report) {
    return join(status.directory, 'report.json');
  }

  return join(status?.recovery?.directory ?? directory, 'task.json');
};

const widgetDetailFields = (
  status: ReturnType<typeof readWidgetStatus>,
  task: Task,
  directory: string,
): Pick<WorkerWidgetRow, 'details' | 'recovery' | 'workerType' | 'detailPath' | 'issue'> => {
  const fields: Pick<
    WorkerWidgetRow,
    'details' | 'recovery' | 'workerType' | 'detailPath' | 'issue'
  > = {
    details: widgetSafety(task),
    workerType: isGenericLoadout(task.loadout) ? `${task.loadout.kind} worker` : 'Pi worker',
    detailPath: widgetEvidencePath(status, directory),
  };

  const recovery = widgetManualCleanup(status);

  if (recovery) {
    fields.recovery = recovery;
  }

  if (!status) {
    fields.issue = 'saved status unavailable; inspect subagent_status';
  }

  return fields;
};

const widgetStatusFields = (
  status: ReturnType<typeof readWidgetStatus>,
  task: Task,
  directory: string,
): Pick<
  WorkerWidgetRow,
  | 'outcome'
  | 'question'
  | 'questionId'
  | 'terminal'
  | 'cleanup'
  | 'cleanupConfirmed'
  | 'stoppedAt'
  | 'details'
  | 'recovery'
  | 'workerType'
  | 'detailPath'
  | 'issue'
  | 'report'
> => ({
  ...widgetRecordFields(status),
  ...widgetDetailFields(status, task, directory),
});

const widgetActivityTime = (
  activity: ReturnType<typeof readWorkerActivity>,
  isCurrent: boolean,
): Pick<WorkerWidgetRow, 'activityAt'> =>
  isCurrent && activity ? { activityAt: activity.updatedAt } : {};

const widgetPhase = (
  activity: ReturnType<typeof readWorkerActivity>,
): Pick<WorkerWidgetRow, 'phaseDescription' | 'phaseDescriptionAt'> => {
  if (activity?.description === undefined) {
    return {};
  }

  if (activity.descriptionAt === undefined) {
    return { phaseDescription: activity.description };
  }

  return {
    phaseDescription: activity.description,
    phaseDescriptionAt: activity.descriptionAt,
  };
};

const buildWidgetRow = (
  directory: string,
  task: Task,
  status: ReturnType<typeof readWidgetStatus>,
  activity: ReturnType<typeof readWorkerActivity>,
  handle: Handle | undefined,
): WorkerWidgetRow => {
  const isCurrent = currentActivity(activity, Date.now());
  const state = status?.state ?? 'unknown';
  const showPhase = state === 'starting' || state === 'running';

  return {
    name: task.name ?? `${namePrefix(task.loadout)}-${task.taskId.slice(0, 6)}`,
    ...(task.label === undefined ? {} : { label: task.label }),
    taskId: task.taskId,
    task: task.task,
    state,
    deadline: task.deadline,
    createdAt: task.createdAt,
    activity: widgetActivity(task, activity, handle, isCurrent, showPhase),
    model: widgetModel(task, activity, isCurrent),
    usage: widgetUsage(task, activity),
    ...widgetActivityTime(activity, isCurrent),
    ...widgetPhase(activity),
    ...widgetStatusFields(status, task, directory),
  };
};

// Launch, replies, and cleanup share ownership state and one deadline. Keep their transitions together.
export class WorkerController {
  private readonly handles = new Map<string, Handle>();
  private readonly capacity = workerCapacity();
  private readonly live = new Set<string>();
  private readonly lifetime = new AbortController();
  private readonly placement = new WorkerPlacement();
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly client: HerdrClient = herdrClient,
    private readonly notify: (notice: WorkerNotice) => void = () => undefined,
  ) {}

  private herdrCall(handle: Handle, signal = handle.abort.signal): TerminalCall {
    return (argumentsList) => this.client(argumentsList, workBudget(handle), signal);
  }

  widgetRows(parentSessionId: string): WorkerWidgetRow[] {
    const rows: WorkerWidgetRow[] = [];

    for (const { directory, task } of readTasks(this.root)) {
      if (task.parentSessionId !== parentSessionId) {
        continue;
      }

      const status = readWidgetStatus(directory, task, this.owns(task.taskId));
      const activity = readWorkerActivity(directory, task.taskId);
      const handle = this.handles.get(task.taskId);

      rows.push(buildWidgetRow(directory, task, status, activity, handle));
    }

    return rows.toSorted((left, right) => right.createdAt - left.createdAt);
  }

  status(taskId: string, parentSessionId: string) {
    const directory = this.statusDirectory(taskId, parentSessionId);
    let handle: Handle | undefined;
    let task: Task | undefined;

    try {
      handle = this.handles.get(taskId);
      task = handle ? handle.task : readTask(directory);

      if (handle != null && handle.recordErrors.length > 0) {
        throw new Error(handle.recordErrors.join('; '));
      }

      return {
        ...taskStatus(directory, this.owns(taskId)),
        ...genericStatus(directory, task, handle, !this.closed),
      };
    } catch (error) {
      return this.statusFailure({ taskId, directory, handle, task, error });
    }
  }

  // Refusals (bad identity, another parent, no saved task) throw as they are; only a saved task record
  // that exists but cannot be read becomes unreadable evidence with a recovery hint.
  private statusDirectory(taskId: string, parentSessionId: string): string {
    try {
      return this.directory(taskId, parentSessionId);
    } catch (error) {
      if (error instanceof TaskAccessError) {
        throw error;
      }

      return this.statusFailure({
        taskId,
        directory: join(this.root, taskId),
        handle: undefined,
        task: undefined,
        error,
      });
    }
  }

  private statusFailure(request: StatusFailureRequest): never {
    // The handle is assigned only after the parent-session check; rejected callers cannot stop work.
    const { taskId, directory, handle, task, error } = request;

    if (handle && !this.closed) {
      void this.stop(handle, 'failure', `Worker evidence unavailable: ${String(error)}. No retry.`);
    }

    const recovery = handle ? handleRecovery(handle) : savedRecovery(task, directory);

    throw new EvidenceUnavailableError({
      taskId,
      ...(task?.name === undefined ? {} : { name: task.name }),
      evidenceError: String(error),
      recovery,
      ...(handle?.cleanupDetail === undefined ? {} : { cleanupDetail: handle.cleanupDetail }),
      ...(handle?.paneId === undefined ? {} : { paneId: handle.paneId }),
      cause: error,
    });
  }

  submissionReceipt(taskId: string, parentSessionId: string, id: string) {
    const directory = this.directory(taskId, parentSessionId);

    if (!isGenericLoadout(readTask(directory).loadout)) {
      throw new Error('Pi workers use structured question receipts.');
    }

    return readGenericSubmission(directory, taskId, id);
  }

  async nativeOutput(taskId: string, parentSessionId: string) {
    this.directory(taskId, parentSessionId);
    const handle = this.handles.get(taskId);

    if (!handle || !isGenericLoadout(handle.task.loadout)) {
      throw new Error('Native output requires an active owned generic worker.');
    }

    if (this.closed || handle.stopping) {
      throw new Error('Native output requires an active owned generic worker.');
    }

    const call = this.herdrCall(handle);
    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    if (location.paneId !== worker.paneId) {
      throw new Error('Worker moved during the native output check.');
    }

    const output = await call(['agent', 'read', worker.paneId]);

    return {
      text: output.slice(0, 8000),
      truncated: output.length > 8000,
      format: 'Herdr response; native text is untrusted, not task acceptance or Tau authorization.',
    };
  }

  owns(taskId: string): boolean {
    return !this.closed && this.handles.has(taskId);
  }

  private savedHandle(directory: string, task: Task): Handle {
    const owned = readOwnedWorker(directory, task);
    const remaining = Math.max(task.deadline - Date.now(), task.cancellationBudget);
    const handle = this.createHandle(directory, task, performance.now() + remaining);

    handle.owned = owned;
    handle.paneId = owned.paneId;
    handle.terminalId = owned.terminalId;
    handle.workerNeverStarted = false;

    if (owned.shellStartedAt != null && owned.shellStartedAt !== '') {
      handle.shell = { processId: owned.shellPid, startedAt: owned.shellStartedAt };
    }

    return handle;
  }

  async resume(parentSessionId: string): Promise<void> {
    for (const { directory, task } of readTasks(this.root)) {
      const foreign = task.parentSessionId !== parentSessionId || this.handles.has(task.taskId);
      const unavailable = this.closed || this.live.size >= this.capacity;

      if (foreign || unavailable || readEvent(directory, task.taskId, 'cleanup')) {
        continue;
      }

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Reattach or stop one saved worker at a time so capacity stays exact.
        await this.resumeSaved(directory, task);
      } catch {
        // A task without readable ownership stays as saved evidence; the other tasks still resume.
      }
    }
  }

  private async resumeSaved(directory: string, task: Task): Promise<void> {
    const handle = this.savedHandle(directory, task);

    if (isGenericLoadout(task.loadout) && !handle.owned?.nativeReference) {
      return;
    }

    // ponytail: PID reuse can make an exited worker look present, costing one identity-checked stop attempt.
    if (remainingWorkBudget(handle) <= 0 && handle.owned && processAbsent(handle.owned.processId)) {
      return;
    }

    // Reserve capacity and expose saved ownership to shutdown before inspection can yield.
    // ponytail: one Pi process per parent session; add cross-process exclusion if concurrent resumes become supported.
    this.handles.set(task.taskId, handle);
    this.live.add(task.taskId);

    try {
      handle.owned = await inspectWorker(handle, this.herdrCall(handle));
      this.lifetime.signal.throwIfAborted();
      this.poll(handle);
    } catch {
      // An expired budget fails the first herdr call; the reserved cleanup budget still stops the worker.
      if (remainingWorkBudget(handle) <= 0) {
        await this.stop(handle, 'timeout');

        return;
      }

      this.handles.delete(task.taskId);
      this.live.delete(task.taskId);
      // Saved evidence remains available; cancellation can still check the saved shell and pane.
    }
  }

  questionReceipt(taskId: string, parentSessionId: string, questionId: string) {
    const directory = this.directory(taskId, parentSessionId);
    const question = readQuestion(directory, taskId, questionId);

    if (!question) {
      throw new Error('Unknown worker question.');
    }

    return {
      question,
      reply: readReply(directory, taskId, questionId),
      acknowledgement: readAcknowledgement(directory, taskId, questionId),
    };
  }

  private async replyGeneric(
    handle: Handle,
    answer: { questionId?: string; replyId: string; reply: string },
  ) {
    requireGenericReplyShape(answer);
    const { directory, task } = handle;
    const call = this.herdrCall(handle);

    // Check the saved submission before native state. A saved reply is never sent twice, so a
    // blocked dialog must not turn a repeat into an error.
    const repeated = repeatedGenericReply(directory, task, answer);

    if (repeated) {
      return repeated;
    }

    handle.nativeState = 'unknown';
    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    ensureReplyActive(handle);

    if (
      location.paneId !== worker.paneId ||
      !['idle', 'working', 'done'].includes(handle.nativeState)
    ) {
      throw new Error(
        'Native worker moved, is blocked, or has unknown state. No text or approval sent.',
      );
    }

    if (
      readGenericSubmission(directory, task.taskId, 'assignment')?.observation?.state !==
      'submitted'
    ) {
      throw new Error(
        'Assignment delivery is not confirmed. Replies cannot bypass native startup approvals or uncertain delivery.',
      );
    }

    const submission = await submitGenericText(directory, task, {
      id: answer.replyId,
      text: answer.reply,
      send: () => {
        ensureReplyActive(handle);

        return call(agentPromptArguments(location.paneId, answer.reply));
      },
    });

    return {
      replyAccepted: true as const,
      name: task.name,
      delivery: deliveryFromSubmission(submission?.observation?.state),
    };
  }

  async reply(
    taskId: string,
    parentSessionId: string,
    answer: { questionId?: string; replyId: string; reply: string; scopeUnchanged: unknown },
  ) {
    const directory = this.directory(taskId, parentSessionId);
    const handle = this.handles.get(taskId);

    if (!handle || this.closed || handle.stopping) {
      throw new Error('No active owned worker for this reply.');
    }

    if (answer.scopeUnchanged !== true) {
      throw new Error('Replies cannot increase scope or change saved worker settings.');
    }

    ensureReplyActive(handle);

    if (isGenericLoadout(handle.task.loadout)) {
      return this.replyGeneric(handle, answer);
    }

    if (answer.questionId == null || answer.questionId === '') {
      throw new Error('Pi replies require a structured questionId.');
    }

    return this.replyPi(directory, handle, answer.questionId, answer);
  }

  private async replyPi(
    directory: string,
    handle: Handle,
    questionId: string,
    answer: { replyId: string; reply: string },
  ) {
    const { taskId } = handle.task;

    const value = {
      version: 1,
      taskId,
      questionId,
      replyId: answer.replyId,
      reply: answer.reply,
    };

    if (readReply(directory, taskId, questionId)) {
      acceptReply(directory, taskId, value);

      return acceptedReply(directory, handle.task, questionId);
    }

    if (readPendingQuestion(directory, taskId)?.questionId !== questionId) {
      throw new Error('Reply does not match the pending question.');
    }

    const call = this.herdrCall(handle);
    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    if (location.paneId !== worker.paneId) {
      throw new Error('Worker moved during identity checks; no input sent.');
    }

    ensureReplyActive(handle);

    // Another caller may have accepted this reply during the identity check. Never send it twice.
    if (readReply(directory, taskId, questionId)) {
      acceptReply(directory, taskId, value);

      return acceptedReply(directory, handle.task, questionId);
    }

    return this.sendPiReply({ directory, handle, questionId, answer, value });
  }

  private async sendPiReply(request: PiReplyRequest) {
    const { directory, handle, questionId, answer, value } = request;
    const { taskId } = handle.task;
    const reference = { version: 1, taskId, questionId, replyId: answer.replyId };
    const prompt = `TAU_REPLY ${JSON.stringify(reference)}`;
    const call = this.herdrCall(handle);

    acceptReply(directory, taskId, value);

    // The reply is saved; a throw here would read as a failed reply and invite a resend.
    let deliveryError: string | undefined;

    try {
      await call(['agent', 'prompt', text(handle.paneId), prompt]);
    } catch (error) {
      deliveryError = errorMessage(error).slice(0, 4000);
    }

    return {
      replyAccepted: true,
      name: handle.task.name,
      workerAcknowledged: replyAcknowledged(directory, taskId, questionId),
      delivery: deliveryError === undefined ? 'sent' : 'uncertain',
      ...(deliveryError === undefined ? {} : { deliveryError }),
    };
  }

  async cancel(taskId: string, parentSessionId: string) {
    const directory = this.directory(taskId, parentSessionId);

    if (this.closed) {
      throw new Error('Parent controller stopped.');
    }

    if (readEvent(directory, taskId, 'cleanup')) {
      return this.status(taskId, parentSessionId);
    }

    const handle = this.handles.get(taskId) ?? this.savedHandle(directory, readTask(directory));

    this.handles.set(taskId, handle);
    this.live.add(taskId);
    await this.stop(handle, 'cancelled');

    return this.status(taskId, parentSessionId);
  }

  // A missing record is an unknown task; the raw file error would expose the record path.
  private savedTask(directory: string): Task {
    try {
      return readTask(directory);
    } catch (error) {
      if (isMissingFile(error)) {
        throw new TaskAccessError('Unknown task.');
      }

      throw error;
    }
  }

  private directory(taskId: string, parentSessionId: string): string {
    if (!isTaskId(taskId)) {
      throw new TaskAccessError('Invalid task identity.');
    }

    const directory = join(this.root, taskId);
    const task = this.handles.get(taskId)?.task ?? this.savedTask(directory);

    if (task.parentSessionId !== parentSessionId) {
      throw new TaskAccessError('Task belongs to another parent session.');
    }

    return directory;
  }

  private noticeStatus(handle: Handle) {
    if (handle.recordErrors.length) {
      throw new Error(handle.recordErrors.join('; '));
    }

    const status = {
      ...taskStatus(handle.directory, this.owns(handle.task.taskId)),
      ...genericStatus(handle.directory, handle.task, handle, !this.closed),
    };

    if (handle.cleanupDetail !== undefined) {
      status.cleanup = handle.cleanupDetail;
    }

    return status;
  }

  private notifySnapshot(
    handle: Handle,
    options: { question?: boolean; failure?: string; delivery?: string } = {},
  ): void {
    const question = options.question ?? false;

    try {
      const status = {
        ...this.noticeStatus(handle),
        ...(options.failure === undefined ? {} : { failure: options.failure }),
        ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
      };

      this.notify({ content: modelStatus(status), details: status, question });
    } catch (error) {
      const evidenceError = [String(error), handle.cleanupDetail]
        .filter((value): value is string => value !== undefined && value !== '')
        .join(' ');

      const details = {
        taskId: handle.task.taskId,
        ...(handle.task.name === undefined ? {} : { name: handle.task.name }),
        evidenceError,
        recovery: handleRecovery(handle),
      };

      this.notify({ content: modelEvidenceNotice(details), details, question });
    }
  }

  launch(input: LaunchInput, signal: AbortSignal = new AbortController().signal) {
    return this.launchTask(input, signal);
  }

  async followUp(
    input: Omit<LaunchInput, 'loadout' | 'startedAt'> & {
      sourceTaskId: string;
      settingsUnchanged: boolean;
    },
    context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>,
    signal: AbortSignal = new AbortController().signal,
  ) {
    const startedAt = { wall: Date.now(), monotonic: performance.now() };
    const timing = launchTiming(input.timeout, startedAt);

    const validationSignal = AbortSignal.any([
      signal,
      this.lifetime.signal,
      AbortSignal.timeout(Math.max(1, remainingLaunchBudget(timing))),
    ]);

    validationSignal.throwIfAborted();

    if (this.closed || !input.settingsUnchanged) {
      throw new Error('Follow-up requires an active parent and explicit unchanged saved settings.');
    }

    const source = authorizeHistoryTask(
      this.root,
      { file: input.parentSession, id: input.parentSessionId },
      input.sourceTaskId,
    );

    if (!isPiLoadout(source.task.loadout)) {
      throw new Error('Non-Pi native continuation is unsupported. Start a fresh task.');
    }

    const native = validateNative(source.task, source.origin);
    const loadout = validateSavedLoadout(source.task.loadout, context);

    validationSignal.throwIfAborted();

    // Validation expiry must not masquerade as caller cancellation during launch/readiness.
    return this.launchTask({ ...input, loadout, startedAt }, signal, {
      ...source,
      native,
    });
  }

  private placeWorker(input: LaunchInput, handle: Handle, call: TerminalCall) {
    return this.placement.place(
      {
        ...(input.parentPane != null && input.parentPane !== ''
          ? { parentPane: input.parentPane }
          : {}),
        visibility: input.visibility ?? 'foreground',
        onCreated: (created) => {
          handle.paneId = created.paneId;
          handle.terminalId = created.terminalId;
          publish(handle.directory, 'pane.json', created);
        },
        cwd: handle.task.loadout.cwd,
        environment: isPiLoadout(handle.task.loadout)
          ? [
              `TAU_WORKER_RECORD=${handle.directory}`,
              `PI_CODING_AGENT_DIR=${handle.task.loadout.agentDirectory}`,
            ]
          : [],
      },
      call,
      handle.abort.signal,
    );
  }

  private async startAgent(handle: Handle, paneId: string, name: string): Promise<void> {
    const { task } = handle;
    const generic = isGenericLoadout(task.loadout) ? task.loadout : undefined;

    // herdr must time out before the client budget kills it, so its structured error survives.
    const budget = workBudget(handle);
    const herdrTimeout = budget - Math.min(3000, Math.ceil(budget / 4));

    // herdr 0.9.1 rejects start timeouts of 3000 ms or less.
    if (herdrTimeout <= 3000) {
      throw new Error('Too little startup budget is left for herdr agent start.');
    }

    handle.workerNeverStarted = false;
    const pending = new AbortController();
    const signal = AbortSignal.any([handle.abort.signal, pending.signal]);
    const call = this.herdrCall(handle, signal);

    handle.starting = Promise.resolve().then(() =>
      call([
        'agent',
        'start',
        name,
        '--kind',
        generic?.kind ?? 'pi',
        '--pane',
        paneId,
        '--timeout',
        String(herdrTimeout),
        '--',
        ...(generic?.arguments ?? workerArguments(task)),
      ]),
    );

    try {
      await Promise.race([handle.starting, waitForWorkerExit(handle, call, signal)]);
    } finally {
      pending.abort();
    }
  }

  private async startWithBusyRetry(
    handle: Handle,
    paneId: string,
    name: string,
    call: TerminalCall,
  ): Promise<void> {
    try {
      await this.startAgent(handle, paneId, name);
    } catch (error) {
      if (!isHerdrError(error, 'agent_pane_busy')) {
        throw error;
      }

      if (!(await verifyRejectedStart(handle, call))) {
        throw error;
      }

      handle.workerNeverStarted = true;
      await waitForShell(handle, paneId, call);

      if (!(await verifyRejectedStart(handle, call))) {
        throw new Error('Shell identity changed before the rejected-start retry.', {
          cause: error,
        });
      }

      publish(handle.directory, 'startRetry.json', {
        taskId: handle.task.taskId,
        at: Date.now(),
        reason: 'agent_pane_busy',
        detail: 'One retry after unchanged-shell and agent-absence verification.',
      });

      await this.startAgent(handle, paneId, name);
    }
  }

  private async startWorker(
    handle: Handle,
    paneId: string,
    name: string,
    call: TerminalCall,
  ): Promise<void> {
    const { task } = handle;
    const generic = isGenericLoadout(task.loadout) ? task.loadout : undefined;

    await this.prepareStart(handle, paneId, call, generic);

    await this.startWithBusyRetry(handle, paneId, name, call).catch((error: unknown) => {
      if (handle.starting === undefined) {
        throw error;
      }

      handle.startError = String(error).slice(0, 4000);

      if (!generic) {
        throw error;
      }

      publish(handle.directory, 'nativeStart-error.json', { detail: handle.startError });
      this.notifySnapshot(handle, { failure: handle.startError });
    });
  }

  private async prepareStart(
    handle: Handle,
    paneId: string,
    call: TerminalCall,
    generic?: GenericLoadout,
  ): Promise<void> {
    const shellPid = await waitForShell(handle, paneId, call);

    // A new shell briefly starts prompt-hook children; wait again instead of failing on one.
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Rechecks share the original startup budget.
      const response = await call(['pane', 'process-info', '--pane', paneId]);
      const information = requireObject(result(response).process_info);

      if (information.pane_id !== paneId || integer(information.shell_pid) !== shellPid) {
        throw new Error('Native start requires an unchanged foreground shell.');
      }

      if (isBareShell(information)) {
        break;
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- Rechecks share the original startup budget.
      if ((await waitForShell(handle, paneId, call)) !== shellPid) {
        throw new Error('Native start requires an unchanged foreground shell.');
      }
    }

    handle.shell = { processId: shellPid, startedAt: await readProcessStart(handle, shellPid) };

    if (!handle.shell.startedAt) {
      throw new Error('Shell start identity is unavailable.');
    }

    publish(handle.directory, 'shell.json', handle.shell);

    if (generic) {
      publish(handle.directory, 'nativeStart-intent.json', {
        taskId: handle.task.taskId,
        kind: generic.kind,
        arguments: generic.arguments,
        terminalId: handle.terminalId,
      });
    }
  }

  private checkFollowUpSource(
    loadout: LaunchInput['loadout'],
    agents: unknown,
    source?: FollowUpPreparation,
  ): void {
    if (!source) {
      return;
    }

    requireUnclaimed(this.root, source);
    refuseLiveNativeWriter(agents, source.task);

    if (!isDeepStrictEqual(loadout, source.task.loadout)) {
      throw new Error('Follow-up cannot change saved worker settings.');
    }
  }

  private hasAssignment(handle: Handle): boolean {
    const { directory, task } = handle;

    return (
      readGenericSubmission(directory, task.taskId, 'assignment') !== undefined ||
      !this.nativeReady(handle)
    );
  }

  private nativeReady(handle: Handle): boolean {
    return ['idle', 'done'].includes(handle.nativeState ?? 'unknown');
  }

  private async dispatch(handle: Handle, call: TerminalCall): Promise<void> {
    const { directory, task } = handle;

    if (isPiLoadout(task.loadout)) {
      publish(directory, 'dispatch.json', { taskId: task.taskId });

      return;
    }

    if (this.hasAssignment(handle)) {
      return;
    }

    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    if (location.paneId !== worker.paneId || !this.nativeReady(handle)) {
      throw new Error('Native worker moved or is not ready for the assignment.');
    }

    workBudget(handle);
    const prompt = genericPrompt(task);

    const submission = await submitGenericText(directory, task, {
      id: 'assignment',
      text: prompt,
      send: () => call(agentPromptArguments(location.paneId, prompt)),
    });

    this.notifyUndelivered(handle, submission?.observation?.state);
  }

  private notifyUndelivered(handle: Handle, state: SubmissionState | undefined): void {
    if (state === undefined || handle.stopping || this.closed) {
      return;
    }

    const delivery = deliveryFromSubmission(state);

    if (delivery !== 'sent') {
      this.notifySnapshot(handle, { delivery });
    }
  }

  // The pane display title is cosmetic. Startup is already complete, so an unresponsive herdr call
  // only delays the launch return by at most the short shared deadline below; it cannot block
  // dispatch or extend the task's original deadline. A rejected or unresolved write leaves the
  // saved pane unchanged.
  private async renameWorkerPane(handle: Handle): Promise<void> {
    if (handle.abort.signal.aborted || this.lifetime.signal.aborted) {
      return;
    }

    const remainingWork = remainingWorkBudget(handle);

    if (remainingWork <= 0) {
      return;
    }

    const budget = Math.min(2_000, remainingWork);
    const deadline = performance.now() + budget;
    const limit = new AbortController();

    const timer = setTimeout(() => {
      limit.abort();
    }, budget);

    const signal = AbortSignal.any([this.lifetime.signal, handle.abort.signal, limit.signal]);

    const call = (argumentsList: string[]) => {
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));

      return this.client(argumentsList, remaining, signal);
    };

    try {
      const ownedLocation = await resolveTerminal(text(handle.terminalId), call);

      await call(['pane', 'rename', ownedLocation.paneId, paneTitle(handle.task)]);
    } catch {
      // Keep the saved pane as-is; the worker still launched with its unique agent key.
    } finally {
      clearTimeout(timer);
    }
  }

  private async launchTask(
    input: LaunchInput,
    launchSignal: AbortSignal,
    source?: FollowUpPreparation,
  ): Promise<ReturnType<WorkerController['status']>> {
    if (this.closed) {
      throw new Error('Parent controller stopped.');
    }

    launchSignal.throwIfAborted();
    const prepared = await this.prepareLaunch(input, launchSignal, source);
    const { handle, name } = prepared;

    try {
      launchSignal.throwIfAborted();
      workBudget(handle);

      const call = this.herdrCall(handle);
      const location = await this.placeWorker(input, handle, call);

      if (source) {
        checkHandoff(source);
      }

      await this.startWorker(handle, location.paneId, name, call);
      await this.finishStartup(handle, call);
      handle.removeLaunchAbort?.();

      await this.renameWorkerPane(handle);
    } catch (error) {
      const reason = remainingWorkBudget(handle) <= 0 ? 'timeout' : 'failure';

      await this.stop(handle, reason, this.startupFailureDetail(handle, error));
    }

    return this.status(prepared.taskId, input.parentSessionId);
  }

  private async prepareLaunch(
    input: LaunchInput,
    launchSignal: AbortSignal,
    source?: FollowUpPreparation,
  ) {
    const taskId = randomUUID();
    const directory = join(this.root, taskId);
    const timing = launchTiming(input.timeout, input.startedAt);

    const task = this.buildTask(input, {
      taskId,
      directory,
      createdAt: timing.createdAt,
      deadline: timing.deadline,
      cancellationBudget: timing.cancellationBudget,
      monotonicDeadline: timing.monotonicDeadline,
      ...(source ? { source } : {}),
    });

    const listing = await this.readAgentListing(launchSignal, timing);

    if (this.closed) {
      throw new Error('Parent controller stopped.');
    }

    if (this.live.size >= this.capacity) {
      const workers = [...this.live].map((id) => {
        const live = this.handles.get(id)?.task;

        return live ? `${live.name ?? id} until ${new Date(live.deadline).toISOString()}` : id;
      });

      throw new Error(
        `Worker capacity full (${this.live.size}/${this.capacity}): ${workers.join(', ')}. No queue. End your turn and retry after a notice reports a worker stopped or cleanupUnconfirmed.`,
      );
    }

    this.checkFollowUpSource(input.loadout, listing.agents, source);

    // Synchronous allocation and publication after listing coordinate launches in this process's event loop,
    // not launches in independent processes.
    const name = allocateName({
      root: this.root,
      parentSessionId: input.parentSessionId,
      loadout: input.loadout,
      live: listing.agents,
      suffix: nameSuffix,
    });

    task.name = name;
    validateTask(task);

    prepareTaskDirectory(directory, task, Boolean(source));
    this.live.add(taskId);

    const handle = this.createHandle(directory, task, timing.expires);

    this.handles.set(taskId, handle);
    this.armHandle(handle, launchSignal);

    return { taskId, handle, name };
  }

  private async readAgentListing(
    launchSignal: AbortSignal,
    timing: ReturnType<typeof launchTiming>,
  ) {
    const remaining = remainingLaunchBudget(timing);

    const listingSignal = AbortSignal.any([
      launchSignal,
      this.lifetime.signal,
      AbortSignal.timeout(Math.max(1, remaining)),
    ]);

    const listing = result(
      await this.client(['agent', 'list'], Math.min(30_000, remaining), listingSignal),
    );

    listingSignal.throwIfAborted();

    if (listing.type !== 'agent_list' || remainingLaunchBudget(timing) <= 0) {
      throw new Error('Invalid live agent listing or original startup budget expired.');
    }

    return listing;
  }

  private buildTask(input: LaunchInput, plan: LaunchTaskPlan): Task {
    return validateTask({
      version: isGenericLoadout(input.loadout) ? 2 : 1,
      name: `${namePrefix(input.loadout)}-00`,
      ...(input.label === undefined ? {} : { label: input.label }),
      taskId: plan.taskId,
      task: input.task,
      parentSession: input.parentSession,
      parentSessionId: input.parentSessionId,
      ...nativeReference(input.loadout, plan.directory, plan.source),
      createdAt: plan.createdAt,
      deadline: plan.deadline,
      cancellationBudget: plan.cancellationBudget,
      monotonicDeadline: plan.monotonicDeadline,
      loadout: input.loadout,
    });
  }

  private createHandle(directory: string, task: Task, expires: number): Handle {
    return {
      directory,
      task,
      abort: new AbortController(),
      expires,
      workerNeverStarted: true,
      recordErrors: [],
      notifiedQuestions: new Set(),
    };
  }

  private armHandle(handle: Handle, launchSignal: AbortSignal): void {
    const abortLaunch = () => {
      void this.stop(handle, 'cancelled');
    };

    launchSignal.addEventListener('abort', abortLaunch, { once: true });

    handle.removeLaunchAbort = () => {
      launchSignal.removeEventListener('abort', abortLaunch);
    };

    handle.timer = setTimeout(
      () => {
        void this.stop(handle, 'timeout');
      },
      Math.max(1, remainingWorkBudget(handle)),
    );
  }

  private async finishStartup(handle: Handle, call: TerminalCall): Promise<void> {
    if (!isPiLoadout(handle.task.loadout)) {
      if (handle.startError !== undefined && (await verifyRejectedStart(handle, call))) {
        handle.workerNeverStarted = true;
        throw new Error(
          `Native startup was rejected by herdr absence evidence. No retry. ${handle.startError}`,
        );
      }

      await this.pollGeneric(handle);

      return;
    }

    handle.owned = await waitForPiIdentity(handle, call);
    publish(handle.directory, 'owned.json', handle.owned);
    const ready = await waitForWorkerReadiness(handle, call);
    const current = await inspectWorker(handle, call);

    if (ready.processId !== current.processId) {
      throw new Error('Native session and worker readiness identities did not match.');
    }

    handle.abort.signal.throwIfAborted();
    await this.dispatch(handle, call);
    this.poll(handle);
  }

  private startupFailureDetail(handle: Handle, error: unknown): string {
    if (handle.starting === undefined) {
      return `No worker was started; no automatic retry. ${String(error)}`;
    }

    return handle.startError !== undefined && handle.workerNeverStarted
      ? `Native startup was rejected by herdr absence evidence; no retry. ${String(error)}`
      : `Startup delivery is uncertain; no automatic retry. ${String(error)}`;
  }

  private poll(handle: Handle): void {
    if (this.closed || handle.stopping) {
      return;
    }

    if (handle.timer) {
      clearTimeout(handle.timer);
    }

    handle.timer = setTimeout(
      () => {
        this.pollOnce(handle);
      },
      Math.max(
        1,
        Math.min(isGenericLoadout(handle.task.loadout) ? 1500 : 250, remainingWorkBudget(handle)),
      ),
    );
  }

  private pollOnce(handle: Handle): void {
    if (isGenericLoadout(handle.task.loadout)) {
      void this.pollGeneric(handle);

      return;
    }

    try {
      if (remainingWorkBudget(handle) <= 0) {
        void this.stop(handle, 'timeout');

        return;
      }

      const settled =
        readEvent(handle.directory, handle.task.taskId, 'settled') !== undefined ||
        readEvent(handle.directory, handle.task.taskId, 'startupFailure') !== undefined;

      const absent = handle.owned !== undefined && processAbsent(handle.owned.processId);

      if (settled || absent) {
        void this.stop(handle, 'completion');

        return;
      }

      this.notifyPendingQuestion(handle);
      this.poll(handle);
    } catch (error) {
      void this.stop(handle, 'failure', `Worker evidence unavailable: ${String(error)}. No retry.`);
    }
  }

  private notifyPendingQuestion(handle: Handle): void {
    const question = readPendingQuestion(handle.directory, handle.task.taskId);

    if (question && !handle.notifiedQuestions.has(question.questionId)) {
      handle.notifiedQuestions.add(question.questionId);
      this.notifySnapshot(handle, { question: true });
    }
  }

  private async pollGeneric(handle: Handle): Promise<void> {
    if (this.closed || handle.stopping) {
      return;
    }

    try {
      await this.pollGenericOnce(handle);
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Awaited calls can stop the handle or controller before this catch runs.
      if (handle.stopping !== undefined || this.closed) {
        return;
      }

      this.reportNativeObservationIssue(handle, error);
      this.poll(handle);
    }
  }

  private async pollGenericOnce(handle: Handle): Promise<void> {
    if (remainingWorkBudget(handle) <= 0) {
      await this.stop(handle, 'timeout');

      return;
    }

    if (await this.stopOnAcceptedReport(handle)) {
      return;
    }

    if (handle.owned && processAbsent(handle.owned.processId)) {
      await this.stop(handle, 'completion');

      return;
    }

    const call = this.herdrCall(handle);
    const previousState = handle.nativeState;

    handle.owned = await inspectWorker(handle, call);
    delete handle.observationIssue;
    this.notifyNativeState(handle, previousState);

    await this.dispatch(handle, call);
    this.poll(handle);
  }

  private async stopOnAcceptedReport(handle: Handle): Promise<boolean> {
    try {
      if (!acceptGenericReport(handle.directory, handle.task)) {
        return false;
      }
    } catch (error) {
      recordNativeIssue(handle, 'nativeFailure.json', error);
      await this.stop(handle, 'completion');

      return true;
    }

    await this.stop(handle, 'completion');

    return true;
  }

  private notifyNativeState(handle: Handle, previousState: string | undefined): void {
    const blocked = ['blocked', 'unknown'].includes(handle.nativeState ?? 'unknown');

    if (handle.nativeState !== previousState && blocked) {
      this.notifySnapshot(handle);
    }
  }

  private reportNativeObservationIssue(handle: Handle, error: unknown): void {
    // One notice per unresolved observation episode. A successful inspection deletes observationIssue,
    // so the next genuine failure notifies again while changing diagnostics stay quiet.
    const firstIssue = handle.observationIssue === undefined;

    recordNativeIssue(handle, 'nativeObservation-error.json', error);
    handle.nativeState = 'unknown';

    if (firstIssue) {
      this.notifySnapshot(handle);
    }
  }

  private stop(
    handle: Handle,
    reason: 'timeout' | 'cancelled' | 'completion' | 'failure',
    failureDetail = 'Worker lifecycle failed; saved evidence may be incomplete. No retry.',
  ): Promise<void> {
    if (handle.stopping) {
      return handle.stopping;
    }

    if (handle.timer) {
      clearTimeout(handle.timer);
    }

    handle.removeLaunchAbort?.();
    handle.abort.abort();

    // A report published between polls must be saved before cleanup can close its pane.
    if (isGenericLoadout(handle.task.loadout)) {
      try {
        acceptGenericReport(handle.directory, handle.task);
      } catch (error) {
        recordNativeIssue(handle, 'nativeFailure.json', error);
      }
    }

    try {
      if (readEvent(handle.directory, handle.task.taskId, 'stopping') === undefined) {
        recordEvent(
          handle.directory,
          handle.task.taskId,
          'stopping',
          'Parent started bounded cleanup.',
        );
      }
    } catch (error) {
      handle.recordErrors.push(String(error));
    }

    const cleaned = this.cleanup(handle, reason, failureDetail);

    handle.stopping = Promise.allSettled([cleaned])
      .then(() => {
        this.live.delete(handle.task.taskId);

        // Keep sharing intact until cleanup finishes, including its queued topology change.
        // Unconfirmed cleanup must still stop contributing placement candidates.
        if (handle.terminalId != null) {
          this.placement.release(handle.terminalId);
        }

        // Report the cleanup failure only once placement cleanup finishes.
        return cleaned;
      })
      .catch((error: unknown) => {
        handle.recordErrors.push(String(error));

        if (this.closed) {
          return;
        }

        this.notifySnapshot(handle);
      });

    return handle.stopping;
  }

  private cleanupFailureDetail(handle: Handle, failureDetail: string): string {
    if (handle.workerNeverStarted && handle.startError !== undefined) {
      return `Startup was rejected or exited before dispatch; worker absence confirmed. No automatic retry. ${handle.startError}`;
    }

    return failureDetail;
  }

  private async recoverStartup(
    handle: Handle,
    call: TerminalCall,
    budget: InspectionBudget,
    record: (operation: () => void) => void,
  ): Promise<string> {
    if (handle.workerNeverStarted || handle.owned) {
      return '';
    }

    try {
      if (handle.starting) {
        // The start usually settles first; an unreferenced timer never holds the process open.
        await Promise.race([
          handle.starting.catch(() => undefined),
          delay(budget.remainingBudget(), undefined, { signal: budget.signal, ref: false }),
        ]);
      }

      handle.workerNeverStarted = await verifyRejectedStart(handle, call, budget);

      if (!handle.workerNeverStarted) {
        if (isPiLoadout(handle.task.loadout)) {
          handle.owned = await waitForPiIdentity(handle, call, budget);

          record(() => {
            publish(handle.directory, 'owned.json', handle.owned);
          });
        } else {
          handle.owned = await inspectWorker(handle, call, budget);
        }
      }

      return '';
    } catch (error) {
      // A worker that left its bare shell before herdr reported its session has nothing left to stop.
      if (error instanceof WorkerExitedError) {
        handle.workerNeverStarted = true;

        return '';
      }

      return ` Cleanup inspection failed: ${String(error)}`;
    }
  }

  private async cleanup(
    handle: Handle,
    reason: 'timeout' | 'cancelled' | 'completion' | 'failure',
    failureDetail: string,
  ): Promise<void> {
    // Receipt failures must never prevent the bounded stop attempt or hide later recording errors.
    const record = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        handle.recordErrors.push(String(error));
      }
    };

    const budget = Math.max(1, remainingCleanupBudget(handle));
    const expires = Math.min(handle.expires, performance.now() + budget);
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(budget)]);

    const remainingBudget = () => {
      signal.throwIfAborted();
      const remaining = Math.floor(expires - performance.now());

      if (remaining <= 0) {
        throw new Error('Original cleanup budget expired.');
      }

      return remaining;
    };

    const call = (argumentsList: string[]) => this.client(argumentsList, remainingBudget(), signal);

    const inspectionFailure = await this.recoverStartup(
      handle,
      call,
      { remainingBudget, signal },
      record,
    );

    let stopped = handle.workerNeverStarted;
    let detail = cleanupDetail(handle, stopped) + inspectionFailure;

    if (stopped && handle.shell && handle.terminalId != null) {
      const closedPane = await closeUnstartedPane({
        handle,
        call,
        remainingBudget,
        signal,
        placement: this.placement,
      });

      stopped = closedPane.stopped;
      handle.workerNeverStarted = stopped;
      detail = closedPane.detail;
    }

    if (handle.owned) {
      const stoppedWorker = await stopOwnedWorker({
        handle,
        owned: handle.owned,
        call,
        remainingBudget,
        signal,
        placement: this.placement,
        client: this.client,
      });

      stopped = stoppedWorker.stopped;
      detail = stoppedWorker.detail;
    }

    if (handle.shutdownReason) {
      detail = `Parent session ${handle.shutdownReason}. ${detail}`;
    }

    const failure = this.cleanupFailureDetail(handle, failureDetail);

    handle.cleanupDetail = reason === 'failure' ? `${detail} ${failure}` : detail;
    this.recordCleanupEvents({ handle, reason, failureDetail: failure, detail, stopped, record });

    this.notifyCleanup(handle, record);
  }

  private recordCleanupEvents(request: CleanupOutcomeRequest): void {
    const { handle, reason, failureDetail, detail, stopped, record } = request;
    const { directory, task } = handle;

    record(() => {
      if (reason === 'timeout' || reason === 'cancelled') {
        if (readEvent(directory, task.taskId, reason) === undefined) {
          recordEvent(directory, task.taskId, reason, {
            detail: `Parent requested ${reason}. ${detail}`,
            stopped,
          });
        }
      } else if (reason === 'failure' && !readEvent(directory, task.taskId, 'startupFailure')) {
        recordEvent(directory, task.taskId, 'startupFailure', failureDetail);
      }
    });

    record(() => {
      recordEvent(directory, task.taskId, 'cleanup', { detail, stopped });
    });
  }

  private notifyCleanup(handle: Handle, record: (operation: () => void) => void): void {
    if (this.closed) {
      return;
    }

    const { directory, task } = handle;

    record(() => {
      recordEvent(directory, task.taskId, 'notified', 'Parent notification attempted once.');
    });

    this.notifySnapshot(handle);
  }

  // Freeze admission before snapshotting handles, but keep cleanup's lifetime signal active.
  async stopAll(reason: SessionShutdownEvent['reason'] = 'quit'): Promise<void> {
    this.closed = true;

    for (const handle of this.handles.values()) {
      handle.shutdownReason = reason;
    }

    await Promise.allSettled(
      [...this.handles.values()].map((handle) => this.stop(handle, 'cancelled')),
    );

    this.close();
  }

  close(): void {
    if (this.lifetime.signal.aborted) {
      return;
    }

    this.closed = true;
    this.lifetime.abort();

    for (const handle of this.handles.values()) {
      clearTimeout(handle.timer);
      handle.removeLaunchAbort?.();
      handle.abort.abort();

      if (handle.stopping) {
        continue;
      }

      // A waiting worker cannot receive a reply from a later controller, so it must stop waiting.
      try {
        recordEvent(
          handle.directory,
          handle.task.taskId,
          'parentClosed',
          'Parent controller closed. Replies are no longer possible.',
        );
      } catch (error) {
        handle.recordErrors.push(String(error));
      }
    }
  }
}
