import { setTimeout as delay } from 'node:timers/promises';

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
import { readPendingQuestion } from '../questionRecords.js';
import { publish, readEvent, readGenericSubmission, recordEvent } from '../records.js';
import { resolveTerminal } from '../terminal.js';
import type { TerminalCall } from '../terminal.js';
import { isGenericLoadout, isPiLoadout } from '../types.js';
import type { SubmissionState, Task } from '../types.js';
import { remainingCleanupBudget, remainingWorkBudget, workBudget } from './budget.js';
import {
  agentPromptArguments,
  inspectWorker,
  verifyRejectedStart,
  waitForPiIdentity,
} from './inspect.js';
import type { HerdrClient } from './inspect.js';
import {
  cleanupDetail,
  genericStatus,
  handleRecovery,
  recordNativeIssue,
  taskStatus,
} from './record.js';
import { WorkerExitedError } from './shellIdentity.js';
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

// Polling, dispatch, stop, and cleanup for one worker share its handle and deadline.
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
