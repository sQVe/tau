import { setTimeout as delay } from 'node:timers/promises';

import { parseModelReference } from '../../../delegateModel/index.js';
import { errorMessage } from '../../../errors/index.js';
import { processAbsent } from '../cancellation.js';
import type { WorkerPlacement } from '../placement.js';
import { modelEvidenceNotice, modelStatus } from '../presentation.js';
import type { WorkerNotice } from '../presentation.js';
import {
  acceptReply,
  readAcknowledgement,
  readPendingQuestion,
  readReply,
} from '../questionRecords.js';
import { publish, readEvent, recordEvent } from '../records.js';
import { requireObject, resolveTerminal, result, text } from '../terminal.js';
import type { TerminalCall } from '../terminal.js';
import { harnessOf, isGenericLoadout, isPiLoadout } from '../types.js';
import type { Task } from '../types.js';
import {
  ensureReplyActive,
  remainingCleanupBudget,
  remainingWorkBudget,
  workBudget,
} from './budget.js';
import {
  dispatchAssignment,
  finishGenericStartup,
  pollGeneric,
  publishNativeStartIntent,
  recordNativeStartError,
  replyGeneric,
  saveReportBeforeStop,
} from './genericWorker.js';
import {
  inspectWorker,
  isHerdrError,
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
  const harness = harnessOf(task.loadout);
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

  get closed(): boolean {
    return this.context.closed();
  }

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

    await this.prepareStart(paneId, call);

    await this.startWithBusyRetry(paneId, name, call).catch((error: unknown) => {
      if (handle.startup.starting === undefined) {
        throw error;
      }

      handle.startup.error = String(error).slice(0, 4000);

      if (!isGenericLoadout(handle.task.loadout)) {
        throw error;
      }

      recordNativeStartError(this, handle.startup.error);
    });
  }

  private async prepareStart(paneId: string, call: TerminalCall): Promise<void> {
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

    if (isGenericLoadout(handle.task.loadout)) {
      publishNativeStartIntent(handle, handle.task.loadout);
    }
  }

  private async finishStartup(call: TerminalCall): Promise<void> {
    const { handle } = this;

    if (!isPiLoadout(handle.task.loadout)) {
      await finishGenericStartup(this, call);

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
      return replyGeneric(this, answer);
    }

    if (answer.questionId == null || answer.questionId === '') {
      throw new Error('Pi replies require a structured questionId.');
    }

    return this.replyPi(directory, answer.questionId, answer);
  }

  private noticeStatus() {
    const { handle } = this;

    if (handle.cleanup.recordErrors.length) {
      throw new Error(handle.cleanup.recordErrors.join('; '));
    }

    const status = {
      ...taskStatus(handle.directory, this.context.owns(handle.task.taskId)),
      ...genericStatus(handle.directory, handle.task, handle, !this.closed),
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

  async dispatch(call: TerminalCall): Promise<void> {
    const { handle } = this;
    const { directory, task } = handle;

    if (isPiLoadout(task.loadout)) {
      publish(directory, 'dispatch.json', { taskId: task.taskId });

      return;
    }

    await dispatchAssignment(this, call);
  }

  poll(): void {
    const { handle } = this;

    if (this.closed || handle.cleanup.stopping) {
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
      void pollGeneric(this);

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

    if (isGenericLoadout(handle.task.loadout)) {
      saveReportBeforeStop(handle);
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

        if (this.closed) {
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
    this.recordCleanupEvents({ reason, failureDetail: failure, detail, stopped, record });

    this.notifyCleanup(record);
  }

  private recordCleanupEvents(request: CleanupOutcomeRequest): void {
    const { reason, failureDetail, detail, stopped, record } = request;
    const { directory, task } = this.handle;

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
    if (this.closed) {
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
