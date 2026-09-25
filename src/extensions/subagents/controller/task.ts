import { setTimeout as delay } from 'node:timers/promises';

import { parseModelReference } from '../../../delegateModel/index.js';
import { errorMessage } from '../../../errors/index.js';
import { processAbsent } from '../cancellation.js';
import {
  acceptGenericReport,
  deliveryFromSubmission,
  genericPrompt,
  submitGenericText,
} from '../generic.js';
import type { WorkerPlacement } from '../placement.js';
import { modelEvidenceNotice, modelStatus } from '../presentation.js';
import type { WorkerNotice } from '../presentation.js';
import {
  acceptReply,
  readAcknowledgement,
  readPendingQuestion,
  readReply,
} from '../questionRecords.js';
import { publish, readEvent, readGenericSubmission, recordEvent } from '../records.js';
import { requireObject, resolveTerminal, result, text } from '../terminal.js';
import type { TerminalCall } from '../terminal.js';
import { isGenericLoadout, isPiLoadout } from '../types.js';
import type { GenericLoadout, SubmissionState, Task } from '../types.js';
import {
  ensureReplyActive,
  remainingCleanupBudget,
  remainingWorkBudget,
  workBudget,
} from './budget.js';
import {
  agentPromptArguments,
  inspectWorker,
  isHerdrError,
  observeWorker,
  verifyRejectedStart,
  waitForPiIdentity,
  waitForWorkerExit,
  waitForWorkerReadiness,
  workerArguments,
} from './inspect.js';
import type { HerdrClient } from './inspect.js';
import {
  cleanupDetail,
  genericStatus,
  handleRecovery,
  readOwnedWorker,
  recordNativeIssue,
  taskStatus,
} from './record.js';
import {
  integer,
  isBareShell,
  readProcessStart,
  waitForShell,
  WorkerExitedError,
} from './shellIdentity.js';
import type { InspectionBudget } from './shellIdentity.js';
import { closeUnstartedPane, stopOwnedWorker } from './stop.js';
import type { Handle } from './types.js';

// What one worker needs from the coordinator. One context is shared by every task.
export interface TaskContext {
  client: HerdrClient;
  notify: (notice: WorkerNotice) => void;
  placement: WorkerPlacement;
  lifetime: AbortSignal;
  closed: () => boolean;
  owns: (taskId: string) => boolean;
  release: (taskId: string) => void;
}

type StopReason = 'timeout' | 'cancelled' | 'completion' | 'failure';

interface PiReplyRequest {
  directory: string;
  questionId: string;
  answer: { replyId: string };
  value: unknown;
}

interface CleanupOutcomeRequest {
  handle: Handle;
  reason: StopReason;
  failureDetail: string;
  detail: string;
  stopped: boolean;
  record: (operation: () => void) => void;
}

export const createHandle = (directory: string, task: Task, expires: number): Handle => ({
  directory,
  task,
  abort: new AbortController(),
  expires,
  identity: {},
  startup: { neverStarted: true },
  observation: { notifiedQuestions: new Set() },
  cleanup: { recordErrors: [] },
});

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

export const savedHandle = (directory: string, task: Task): Handle => {
  const owned = readOwnedWorker(directory, task);
  const remaining = Math.max(task.deadline - Date.now(), task.cancellationBudget);
  const handle = createHandle(directory, task, performance.now() + remaining);

  handle.identity.owned = owned;
  handle.identity.paneId = owned.paneId;
  handle.identity.terminalId = owned.terminalId;
  handle.startup.neverStarted = false;

  if (owned.shellStartedAt != null && owned.shellStartedAt !== '') {
    handle.identity.shell = { processId: owned.shellPid, startedAt: owned.shellStartedAt };
  }

  return handle;
};

// Startup, replies, polling, dispatch, stop, and cleanup for one worker share its handle and deadline.
export class TaskController {
  constructor(
    readonly handle: Handle,
    private readonly context: TaskContext,
  ) {}

  herdrCall(signal = this.handle.abort.signal): TerminalCall {
    return (argumentsList) => this.context.client(argumentsList, workBudget(this.handle), signal);
  }

  arm(launchSignal: AbortSignal): void {
    const abortLaunch = () => {
      void this.stop('cancelled');
    };

    launchSignal.addEventListener('abort', abortLaunch, { once: true });

    this.handle.removeLaunchAbort = () => {
      launchSignal.removeEventListener('abort', abortLaunch);
    };

    this.handle.timer = setTimeout(
      () => {
        void this.stop('timeout');
      },
      Math.max(1, remainingWorkBudget(this.handle)),
    );
  }

  // Startup runs once, after placement; the caller stops the worker when it throws.
  async start(paneId: string, name: string, call: TerminalCall): Promise<void> {
    await this.startWorker(paneId, name, call);
    await this.finishStartup(call);
    this.handle.removeLaunchAbort?.();

    await this.renameWorkerPane();
  }

  private async startAgent(paneId: string, name: string): Promise<void> {
    const { handle } = this;
    const { task } = handle;
    const generic = isGenericLoadout(task.loadout) ? task.loadout : undefined;

    // herdr must time out before the client budget kills it, so its structured error survives.
    const budget = workBudget(handle);
    const herdrTimeout = budget - Math.min(3000, Math.ceil(budget / 4));

    // herdr 0.9.1 rejects start timeouts of 3000 ms or less.
    if (herdrTimeout <= 3000) {
      throw new Error('Too little startup budget is left for herdr agent start.');
    }

    handle.startup.neverStarted = false;
    const pending = new AbortController();
    const signal = AbortSignal.any([handle.abort.signal, pending.signal]);
    const call = this.herdrCall(signal);

    handle.startup.starting = Promise.resolve().then(() =>
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
      await Promise.race([handle.startup.starting, waitForWorkerExit(handle, call, signal)]);
    } finally {
      pending.abort();
    }
  }

  private async startWithBusyRetry(
    paneId: string,
    name: string,
    call: TerminalCall,
  ): Promise<void> {
    const { handle } = this;

    try {
      await this.startAgent(paneId, name);
    } catch (error) {
      if (!isHerdrError(error, 'agent_pane_busy')) {
        throw error;
      }

      if (!(await verifyRejectedStart(handle, call))) {
        throw error;
      }

      handle.startup.neverStarted = true;
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

      await this.startAgent(paneId, name);
    }
  }

  private async startWorker(paneId: string, name: string, call: TerminalCall): Promise<void> {
    const { handle } = this;
    const { task } = handle;
    const generic = isGenericLoadout(task.loadout) ? task.loadout : undefined;

    await this.prepareStart(paneId, call, generic);

    await this.startWithBusyRetry(paneId, name, call).catch((error: unknown) => {
      if (handle.startup.starting === undefined) {
        throw error;
      }

      handle.startup.error = String(error).slice(0, 4000);

      if (!generic) {
        throw error;
      }

      publish(handle.directory, 'nativeStart-error.json', { detail: handle.startup.error });
      this.notifySnapshot({ failure: handle.startup.error });
    });
  }

  private async prepareStart(
    paneId: string,
    call: TerminalCall,
    generic?: GenericLoadout,
  ): Promise<void> {
    const { handle } = this;
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

    handle.identity.shell = {
      processId: shellPid,
      startedAt: await readProcessStart(handle, shellPid),
    };

    if (!handle.identity.shell.startedAt) {
      throw new Error('Shell start identity is unavailable.');
    }

    publish(handle.directory, 'shell.json', handle.identity.shell);

    if (generic) {
      publish(handle.directory, 'nativeStart-intent.json', {
        taskId: handle.task.taskId,
        kind: generic.kind,
        arguments: generic.arguments,
        terminalId: handle.identity.terminalId,
      });
    }
  }

  private async finishStartup(call: TerminalCall): Promise<void> {
    const { handle } = this;

    if (!isPiLoadout(handle.task.loadout)) {
      if (handle.startup.error !== undefined && (await verifyRejectedStart(handle, call))) {
        handle.startup.neverStarted = true;
        throw new Error(
          `Native startup was rejected by herdr absence evidence. No retry. ${handle.startup.error}`,
        );
      }

      await this.pollGeneric();

      return;
    }

    handle.identity.owned = await waitForPiIdentity(handle, call);
    publish(handle.directory, 'owned.json', handle.identity.owned);
    const ready = await waitForWorkerReadiness(handle, call);
    const current = await inspectWorker(handle, call);

    if (ready.processId !== current.processId) {
      throw new Error('Native session and worker readiness identities did not match.');
    }

    handle.abort.signal.throwIfAborted();
    await this.dispatch(call);
    this.poll();
  }

  startupFailureDetail(error: unknown): string {
    const { handle } = this;

    if (handle.startup.starting === undefined) {
      return `No worker was started; no automatic retry. ${String(error)}`;
    }

    return handle.startup.error !== undefined && handle.startup.neverStarted
      ? `Native startup was rejected by herdr absence evidence; no retry. ${String(error)}`
      : `Startup delivery is uncertain; no automatic retry. ${String(error)}`;
  }

  // The pane display title is cosmetic. Startup is already complete, so an unresponsive herdr call
  // only delays the launch return by at most the short shared deadline below; it cannot block
  // dispatch or extend the task's original deadline. A rejected or unresolved write leaves the
  // saved pane unchanged.
  private async renameWorkerPane(): Promise<void> {
    const { handle } = this;

    if (handle.abort.signal.aborted || this.context.lifetime.aborted) {
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

    const signal = AbortSignal.any([this.context.lifetime, handle.abort.signal, limit.signal]);

    const call = (argumentsList: string[]) => {
      const remaining = Math.max(1, Math.floor(deadline - performance.now()));

      return this.context.client(argumentsList, remaining, signal);
    };

    try {
      const ownedLocation = await resolveTerminal(text(handle.identity.terminalId), call);

      await call(['pane', 'rename', ownedLocation.paneId, paneTitle(handle.task)]);
    } catch {
      // Keep the saved pane as-is; the worker still launched with its unique agent key.
    } finally {
      clearTimeout(timer);
    }
  }

  private async replyGeneric(answer: { questionId?: string; replyId: string; reply: string }) {
    requireGenericReplyShape(answer);
    const { handle } = this;
    const { directory, task } = handle;
    const call = this.herdrCall();

    // Check the saved submission before native state. A saved reply is never sent twice, so a
    // blocked dialog must not turn a repeat into an error.
    const repeated = repeatedGenericReply(directory, task, answer);

    if (repeated) {
      return repeated;
    }

    handle.observation.nativeState = 'unknown';
    const inspected = await inspectWorker(handle, call);
    const location = await resolveTerminal(inspected.terminalId, call);

    ensureReplyActive(handle);

    if (
      location.paneId !== inspected.paneId ||
      !['idle', 'working', 'done'].includes(handle.observation.nativeState)
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

  private async replyPi(
    directory: string,
    questionId: string,
    answer: { replyId: string; reply: string },
  ) {
    const { handle } = this;
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

    const call = this.herdrCall();
    const inspected = await inspectWorker(handle, call);
    const location = await resolveTerminal(inspected.terminalId, call);

    if (location.paneId !== inspected.paneId) {
      throw new Error('Worker moved during identity checks; no input sent.');
    }

    ensureReplyActive(handle);

    // Another caller may have accepted this reply during the identity check. Never send it twice.
    if (readReply(directory, taskId, questionId)) {
      acceptReply(directory, taskId, value);

      return acceptedReply(directory, handle.task, questionId);
    }

    return this.sendPiReply({ directory, questionId, answer, value });
  }

  private async sendPiReply(request: PiReplyRequest) {
    const { directory, questionId, answer, value } = request;
    const { handle } = this;
    const { taskId } = handle.task;
    const reference = { version: 1, taskId, questionId, replyId: answer.replyId };
    const prompt = `TAU_REPLY ${JSON.stringify(reference)}`;
    const call = this.herdrCall();

    acceptReply(directory, taskId, value);

    // The reply is saved; a throw here would read as a failed reply and invite a resend.
    let deliveryError: string | undefined;

    try {
      await call(['agent', 'prompt', text(handle.identity.paneId), prompt]);
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

  async reply(directory: string, answer: { questionId?: string; replyId: string; reply: string }) {
    if (isGenericLoadout(this.handle.task.loadout)) {
      return this.replyGeneric(answer);
    }

    if (answer.questionId == null || answer.questionId === '') {
      throw new Error('Pi replies require a structured questionId.');
    }

    return this.replyPi(directory, answer.questionId, answer);
  }

  async nativeOutput() {
    const { handle } = this;
    const call = this.herdrCall();
    // Reading output only verifies identity; the poll loop owns the handle and saved records.
    const { worker } = await observeWorker(handle, call);
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

  private noticeStatus() {
    const { handle } = this;

    if (handle.cleanup.recordErrors.length) {
      throw new Error(handle.cleanup.recordErrors.join('; '));
    }

    const status = {
      ...taskStatus(handle.directory, this.context.owns(handle.task.taskId)),
      ...genericStatus(handle.directory, handle.task, handle, !this.context.closed()),
    };

    if (handle.cleanup.detail !== undefined) {
      status.cleanup = handle.cleanup.detail;
    }

    return status;
  }

  notifySnapshot(options: { question?: boolean; failure?: string; delivery?: string } = {}): void {
    const { handle } = this;
    const question = options.question ?? false;

    try {
      const status = {
        ...this.noticeStatus(),
        ...(options.failure === undefined ? {} : { failure: options.failure }),
        ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
      };

      this.context.notify({ content: modelStatus(status), details: status, question });
    } catch (error) {
      const evidenceError = [String(error), handle.cleanup.detail]
        .filter((value): value is string => value !== undefined && value !== '')
        .join(' ');

      const details = {
        taskId: handle.task.taskId,
        ...(handle.task.name === undefined ? {} : { name: handle.task.name }),
        evidenceError,
        recovery: handleRecovery(handle),
      };

      this.context.notify({ content: modelEvidenceNotice(details), details, question });
    }
  }

  private hasAssignment(): boolean {
    const { directory, task } = this.handle;

    return (
      readGenericSubmission(directory, task.taskId, 'assignment') !== undefined ||
      !this.nativeReady()
    );
  }

  private nativeReady(): boolean {
    return ['idle', 'done'].includes(this.handle.observation.nativeState ?? 'unknown');
  }

  async dispatch(call: TerminalCall): Promise<void> {
    const { handle } = this;
    const { directory, task } = handle;

    if (isPiLoadout(task.loadout)) {
      publish(directory, 'dispatch.json', { taskId: task.taskId });

      return;
    }

    if (this.hasAssignment()) {
      return;
    }

    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    if (location.paneId !== worker.paneId || !this.nativeReady()) {
      throw new Error('Native worker moved or is not ready for the assignment.');
    }

    workBudget(handle);
    const prompt = genericPrompt(task);

    const submission = await submitGenericText(directory, task, {
      id: 'assignment',
      text: prompt,
      send: () => call(agentPromptArguments(location.paneId, prompt)),
    });

    this.notifyUndelivered(submission?.observation?.state);
  }

  private notifyUndelivered(state: SubmissionState | undefined): void {
    if (state === undefined || this.handle.cleanup.stopping || this.context.closed()) {
      return;
    }

    const delivery = deliveryFromSubmission(state);

    if (delivery !== 'sent') {
      this.notifySnapshot({ delivery });
    }
  }

  poll(): void {
    const { handle } = this;

    if (this.context.closed() || handle.cleanup.stopping) {
      return;
    }

    if (handle.timer) {
      clearTimeout(handle.timer);
    }

    handle.timer = setTimeout(
      () => {
        this.pollOnce();
      },
      Math.max(
        1,
        Math.min(isGenericLoadout(handle.task.loadout) ? 1500 : 250, remainingWorkBudget(handle)),
      ),
    );
  }

  private pollOnce(): void {
    const { handle } = this;

    if (isGenericLoadout(handle.task.loadout)) {
      void this.pollGeneric();

      return;
    }

    try {
      if (remainingWorkBudget(handle) <= 0) {
        void this.stop('timeout');

        return;
      }

      const settled =
        readEvent(handle.directory, handle.task.taskId, 'settled') !== undefined ||
        readEvent(handle.directory, handle.task.taskId, 'startupFailure') !== undefined;

      const absent =
        handle.identity.owned !== undefined && processAbsent(handle.identity.owned.processId);

      if (settled || absent) {
        void this.stop('completion');

        return;
      }

      this.notifyPendingQuestion();
      this.poll();
    } catch (error) {
      void this.stop('failure', `Worker evidence unavailable: ${String(error)}. No retry.`);
    }
  }

  private notifyPendingQuestion(): void {
    const { handle } = this;
    const question = readPendingQuestion(handle.directory, handle.task.taskId);

    if (question && !handle.observation.notifiedQuestions.has(question.questionId)) {
      handle.observation.notifiedQuestions.add(question.questionId);
      this.notifySnapshot({ question: true });
    }
  }

  async pollGeneric(): Promise<void> {
    const { handle } = this;

    if (this.context.closed() || handle.cleanup.stopping) {
      return;
    }

    try {
      await this.pollGenericOnce();
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Awaited calls can stop the handle or controller before this catch runs.
      if (handle.cleanup.stopping !== undefined || this.context.closed()) {
        return;
      }

      this.reportNativeObservationIssue(error);
      this.poll();
    }
  }

  private async pollGenericOnce(): Promise<void> {
    const { handle } = this;

    if (remainingWorkBudget(handle) <= 0) {
      await this.stop('timeout');

      return;
    }

    if (await this.stopOnAcceptedReport()) {
      return;
    }

    if (handle.identity.owned && processAbsent(handle.identity.owned.processId)) {
      await this.stop('completion');

      return;
    }

    const call = this.herdrCall();
    const previousState = handle.observation.nativeState;

    handle.identity.owned = await inspectWorker(handle, call);
    delete handle.observation.issue;
    this.notifyNativeState(previousState);

    await this.dispatch(call);
    this.poll();
  }

  private async stopOnAcceptedReport(): Promise<boolean> {
    const { handle } = this;

    try {
      if (!acceptGenericReport(handle.directory, handle.task)) {
        return false;
      }
    } catch (error) {
      recordNativeIssue(handle, 'nativeFailure.json', error);
      await this.stop('completion');

      return true;
    }

    await this.stop('completion');

    return true;
  }

  private notifyNativeState(previousState: string | undefined): void {
    const { handle } = this;
    const blocked = ['blocked', 'unknown'].includes(handle.observation.nativeState ?? 'unknown');

    if (handle.observation.nativeState !== previousState && blocked) {
      this.notifySnapshot();
    }
  }

  private reportNativeObservationIssue(error: unknown): void {
    const { handle } = this;
    // One notice per unresolved observation episode. A successful inspection deletes the issue,
    // so the next genuine failure notifies again while changing diagnostics stay quiet.
    const firstIssue = handle.observation.issue === undefined;

    recordNativeIssue(handle, 'nativeObservation-error.json', error);
    handle.observation.nativeState = 'unknown';

    if (firstIssue) {
      this.notifySnapshot();
    }
  }

  stop(
    reason: StopReason,
    failureDetail = 'Worker lifecycle failed; saved evidence may be incomplete. No retry.',
  ): Promise<void> {
    const { handle } = this;

    if (handle.cleanup.stopping) {
      return handle.cleanup.stopping;
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
      handle.cleanup.recordErrors.push(String(error));
    }

    const cleaned = this.cleanup(reason, failureDetail);

    handle.cleanup.stopping = Promise.allSettled([cleaned])
      .then(() => {
        this.context.release(handle.task.taskId);

        // Keep sharing intact until cleanup finishes, including its queued topology change.
        // Unconfirmed cleanup must still stop contributing placement candidates.
        if (handle.identity.terminalId != null) {
          this.context.placement.release(handle.identity.terminalId);
        }

        // Report the cleanup failure only once placement cleanup finishes.
        return cleaned;
      })
      .catch((error: unknown) => {
        handle.cleanup.recordErrors.push(String(error));

        if (this.context.closed()) {
          return;
        }

        this.notifySnapshot();
      });

    return handle.cleanup.stopping;
  }

  private cleanupFailureDetail(failureDetail: string): string {
    const { handle } = this;

    if (handle.startup.neverStarted && handle.startup.error !== undefined) {
      return `Startup was rejected or exited before dispatch; worker absence confirmed. No automatic retry. ${handle.startup.error}`;
    }

    return failureDetail;
  }

  private async recoverStartup(
    call: TerminalCall,
    budget: InspectionBudget,
    record: (operation: () => void) => void,
  ): Promise<string> {
    const { handle } = this;

    if (handle.startup.neverStarted || handle.identity.owned) {
      return '';
    }

    try {
      if (handle.startup.starting) {
        // The start usually settles first; an unreferenced timer never holds the process open.
        await Promise.race([
          handle.startup.starting.catch(() => undefined),
          delay(budget.remainingBudget(), undefined, { signal: budget.signal, ref: false }),
        ]);
      }

      handle.startup.neverStarted = await verifyRejectedStart(handle, call, budget);

      if (!handle.startup.neverStarted) {
        if (isPiLoadout(handle.task.loadout)) {
          handle.identity.owned = await waitForPiIdentity(handle, call, budget);

          record(() => {
            publish(handle.directory, 'owned.json', handle.identity.owned);
          });
        } else {
          handle.identity.owned = await inspectWorker(handle, call, budget);
        }
      }

      return '';
    } catch (error) {
      // A worker that left its bare shell before herdr reported its session has nothing left to stop.
      if (error instanceof WorkerExitedError) {
        handle.startup.neverStarted = true;

        return '';
      }

      return ` Cleanup inspection failed: ${String(error)}`;
    }
  }

  private async cleanup(reason: StopReason, failureDetail: string): Promise<void> {
    const { handle } = this;

    // Receipt failures must never prevent the bounded stop attempt or hide later recording errors.
    const record = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        handle.cleanup.recordErrors.push(String(error));
      }
    };

    const budget = Math.max(1, remainingCleanupBudget(handle));
    const expires = Math.min(handle.expires, performance.now() + budget);
    const signal = AbortSignal.any([this.context.lifetime, AbortSignal.timeout(budget)]);

    const remainingBudget = () => {
      signal.throwIfAborted();
      const remaining = Math.floor(expires - performance.now());

      if (remaining <= 0) {
        throw new Error('Original cleanup budget expired.');
      }

      return remaining;
    };

    const call = (argumentsList: string[]) =>
      this.context.client(argumentsList, remainingBudget(), signal);

    const inspectionFailure = await this.recoverStartup(call, { remainingBudget, signal }, record);

    let stopped = handle.startup.neverStarted;
    let detail = cleanupDetail(handle, stopped) + inspectionFailure;

    if (stopped && handle.identity.shell && handle.identity.terminalId != null) {
      const closedPane = await closeUnstartedPane({
        handle,
        call,
        remainingBudget,
        signal,
        placement: this.context.placement,
      });

      stopped = closedPane.stopped;
      handle.startup.neverStarted = stopped;
      detail = closedPane.detail;
    }

    if (handle.identity.owned) {
      const stoppedWorker = await stopOwnedWorker({
        handle,
        owned: handle.identity.owned,
        call,
        remainingBudget,
        signal,
        placement: this.context.placement,
        client: this.context.client,
      });

      stopped = stoppedWorker.stopped;
      detail = stoppedWorker.detail;
    }

    if (handle.cleanup.shutdownReason) {
      detail = `Parent session ${handle.cleanup.shutdownReason}. ${detail}`;
    }

    const failure = this.cleanupFailureDetail(failureDetail);

    handle.cleanup.detail = reason === 'failure' ? `${detail} ${failure}` : detail;
    this.recordCleanupEvents({ handle, reason, failureDetail: failure, detail, stopped, record });

    this.notifyCleanup(record);
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

  private notifyCleanup(record: (operation: () => void) => void): void {
    if (this.context.closed()) {
      return;
    }

    const { directory, task } = this.handle;

    record(() => {
      recordEvent(directory, task.taskId, 'notified', 'Parent notification attempted once.');
    });

    this.notifySnapshot();
  }

  close(): void {
    const { handle } = this;

    clearTimeout(handle.timer);
    handle.removeLaunchAbort?.();
    handle.abort.abort();

    if (handle.cleanup.stopping) {
      return;
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
      handle.cleanup.recordErrors.push(String(error));
    }
  }
}
