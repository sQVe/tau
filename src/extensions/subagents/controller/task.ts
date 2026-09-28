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
import { resolveTerminal, text } from '../terminal.js';
import type { TerminalCall } from '../terminal.js';
import type { Task } from '../types.js';
import {
  ensureReplyActive,
  remainingCleanupBudget,
  remainingWorkBudget,
  workBudget,
} from './budget.js';
import { inspectWorker, waitForPiIdentity, waitForWorkerReadiness } from './inspect.js';
import type { HerdrClient } from './inspect.js';
import { handleRecovery, readOwnedWorker, taskStatus } from './record.js';
import { stopPiWorker } from './stop.js';
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
  const name = task.name ?? 'worker';
  const model = parseModelReference(task.loadout.model)?.id;

  if (model === undefined) {
    return name;
  }

  return `${name} (${model.replace(/[^a-zA-Z0-9._-]/g, '-')})`;
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

  // Placement starts the worker as its pane's process. Startup then runs once and the caller stops
  // the worker when it throws.
  async start(call: TerminalCall): Promise<void> {
    await this.finishStartup(call);
    this.handle.removeLaunchAbort?.();

    await this.renameWorkerPane();
  }

  private async finishStartup(call: TerminalCall): Promise<void> {
    const { handle } = this;

    handle.identity.owned = await waitForPiIdentity(handle, call);
    publish(handle.directory, 'owned.json', handle.identity.owned);
    const ready = await waitForWorkerReadiness(handle, call);
    const current = await inspectWorker(handle, call);

    if (ready.processId !== current.processId) {
      throw new Error('Native session and worker readiness identities did not match.');
    }

    handle.abort.signal.throwIfAborted();
    publish(handle.directory, 'dispatch.json', { taskId: handle.task.taskId });
    this.poll();
  }

  startupFailureDetail(error: unknown): string {
    const { handle } = this;

    return handle.startup.neverStarted
      ? `No worker was started; no automatic retry. ${String(error)}`
      : `Worker startup failed; no automatic retry. ${String(error)}`;
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

  async reply(directory: string, answer: { questionId: string; replyId: string; reply: string }) {
    const { handle } = this;
    const { taskId } = handle.task;
    const { questionId } = answer;

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

  private noticeStatus() {
    const { handle } = this;

    if (handle.cleanup.recordErrors.length) {
      throw new Error(handle.cleanup.recordErrors.join('; '));
    }

    const status = taskStatus(handle.directory, this.context.owns(handle.task.taskId));

    if (handle.cleanup.detail !== undefined) {
      status.cleanup = handle.cleanup.detail;
    }

    return status;
  }

  private notifySnapshot(question = false): void {
    const { handle } = this;

    try {
      const status = this.noticeStatus();

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
      Math.max(1, Math.min(250, remainingWorkBudget(handle))),
    );
  }

  private pollOnce(): void {
    const { handle } = this;

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
      this.notifySnapshot(true);
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
      .then(async ([outcome]) => {
        this.context.release(handle.task.taskId);

        // Keep sharing intact until cleanup finishes, including its queued topology change.
        // Unconfirmed cleanup must still stop contributing placement candidates.
        if (handle.identity.terminalId != null) {
          const stopped = outcome.status === 'fulfilled' && outcome.value;

          // A pane that may still run keeps its name in the tab label. The label is cosmetic, so
          // its rename gets a short deadline of its own.
          this.context.placement.release(
            handle.identity.terminalId,
            stopped
              ? (argumentsList) => this.context.client(argumentsList, 2_000, this.context.lifetime)
              : undefined,
          );
        }

        // Report the cleanup failure only once placement cleanup finishes.
        await cleaned;
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

  // Resolves whether the worker's pane is confirmed stopped.
  private async cleanup(reason: StopReason, failureDetail: string): Promise<boolean> {
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

    const stop = await stopPiWorker({
      handle,
      call,
      remainingBudget,
      signal,
      placement: this.context.placement,
      graceful: reason === 'completion',
    });

    const { stopped } = stop;
    let { detail } = stop;

    if (handle.cleanup.shutdownReason) {
      detail = `Parent session ${handle.cleanup.shutdownReason}. ${detail}`;
    }

    const failure = failureDetail;

    handle.cleanup.detail = reason === 'failure' ? `${detail} ${failure}` : detail;
    this.recordCleanupEvents({ reason, failureDetail: failure, detail, stopped, record });

    this.notifyCleanup(record);

    return stopped;
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
