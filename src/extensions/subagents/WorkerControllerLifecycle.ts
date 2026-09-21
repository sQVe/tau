import { join } from 'node:path';

import { requireActiveAncestry } from './admission.js';
import { remainingWorkBudget } from './controllerBudget.js';
import { inspectWorker, processAbsent } from './controllerInspect.js';
import {
  cleanupDetail,
  nativeDescription,
  recordNativeIssue,
  taskStatus,
} from './controllerRecord.js';
import { stopOwnedWorker } from './controllerStop.js';
import type { Handle } from './controllerTypes.js';
import { acceptGenericReport } from './generic.js';
import { readPendingQuestion } from './questionRecords.js';
import { readEvent, readTask, recordEvent } from './records.js';
import { isGenericLoadout } from './types.js';
import { WorkerControllerLaunch } from './WorkerControllerLaunch.js';

interface CleanupOutcomeRequest {
  handle: Handle;
  reason: 'timeout' | 'cancelled' | 'completion' | 'failure';
  failureDetail: string;
  detail: string;
  stopped: boolean;
  record: (operation: () => void) => void;
}

export class WorkerControllerLifecycle extends WorkerControllerLaunch {
  protected poll(handle: Handle): void {
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
        Math.min(
          isGenericLoadout(handle.task.loadout) ? 1500 : 250,
          handle.expires - handle.task.cancellationBudget - performance.now(),
        ),
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

      if (handle.task.tree.parentTaskId) {
        try {
          requireActiveAncestry(
            this.root,
            readTask(join(this.root, handle.task.tree.parentTaskId)),
          );
        } catch {
          void this.stop(handle, 'cancelled');

          return;
        }
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
      this.notify(
        `Worker ${handle.task.name ?? 'unnamed'} (${handle.task.taskId}) asks: ${question.question}\nReply with subagent_reply using questionId ${question.questionId}. The original deadline still applies.`,
        question,
      );
    }
  }

  protected async pollGeneric(handle: Handle): Promise<void> {
    if (this.closed || handle.stopping) {
      return;
    }

    try {
      await this.pollGenericOnce(handle);
    } catch (error) {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Awaited calls can stop the handle or controller before this catch runs.
      if (handle.stopping || this.closed) {
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

    const call = (argumentsList: string[]) =>
      this.client(argumentsList, remainingWorkBudget(handle), handle.abort.signal);
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
      this.notify(
        `Worker ${handle.task.taskId}: ${handle.nativeState}. Inspect the native dialog; no approval is automatic. The original deadline remains active.`,
      );
    }
  }

  private reportNativeObservationIssue(handle: Handle, error: unknown): void {
    const previousIssue = handle.observationIssue;

    recordNativeIssue(handle, 'nativeObservation-error.json', error);
    handle.nativeState = 'unknown';

    if (previousIssue !== handle.observationIssue) {
      this.notify(
        `Worker ${handle.task.taskId}: native observation or delivery is uncertain. ${handle.observationIssue} Inspect saved submission intent; no automatic retry. The original deadline remains active.`,
      );
    }
  }

  protected stop(
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
      recordEvent(
        handle.directory,
        handle.task.taskId,
        'stopping',
        'Parent started bounded cleanup; no further delegation is authorized.',
      );
    } catch (error) {
      handle.recordErrors.push(String(error));
    }

    const cleaned = this.cleanup(handle, reason, failureDetail);

    handle.stopping = Promise.allSettled([cleaned])
      .then(() => {
        // Keep sharing intact until cleanup finishes, including its queued topology change.
        // Unconfirmed cleanup must still stop contributing placement candidates.
        if (handle.terminalId) {
          this.placement.release(handle.terminalId);
        }

        // Report the cleanup failure only once the whole subtree has settled.
        return cleaned;
      })
      .catch((error: unknown) => {
        handle.cleanupFinished = true;
        handle.recordErrors.push(String(error));

        if (this.closed) {
          return;
        }

        this.notify(
          `Worker ${handle.task.name ?? 'unnamed'} (${handle.task.taskId}): cleanup unconfirmed. ${String(error)}. Check pane ${handle.paneId ?? 'unknown'} manually. Records: ${handle.directory}. ${nativeDescription(handle.task, handle.directory)}`,
        );
      });

    return handle.stopping;
  }

  private async cleanup(
    handle: Handle,
    reason: 'timeout' | 'cancelled' | 'completion' | 'failure',
    failureDetail: string,
  ): Promise<void> {
    const { task } = handle;
    // Receipt failures must never prevent the bounded stop attempt or hide later recording errors.
    const record = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        handle.recordErrors.push(String(error));
      }
    };
    const budget = Math.max(
      1,
      Math.floor(Math.min(task.cancellationBudget, handle.expires - performance.now())),
    );
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
    let stopped = handle.workerNeverStarted;
    let detail = cleanupDetail(handle, stopped);

    if (handle.owned) {
      const result = await stopOwnedWorker({
        handle,
        owned: handle.owned,
        call,
        remainingBudget,
        signal,
        placement: this.placement,
        client: this.client,
      });
      stopped = result.stopped;
      detail = result.detail;
    }

    handle.cleanupDetail = reason === 'failure' ? `${detail} ${failureDetail}` : detail;
    const outcome = this.recordCleanupOutcome({
      handle,
      reason,
      failureDetail,
      detail,
      stopped,
      record,
    });

    handle.cleanupFinished = true;
    this.notifyCleanup(handle, outcome, record);
  }

  private recordCleanupOutcome(request: CleanupOutcomeRequest): string {
    const { handle, reason, failureDetail, detail, stopped, record } = request;
    const { directory, task } = handle;
    let outcome: string = reason;

    record(() => {
      if (reason === 'timeout' || reason === 'cancelled') {
        recordEvent(directory, task.taskId, reason, {
          detail: `Parent requested ${reason}. ${detail}`,
          stopped,
        });
      } else if (reason === 'failure' && !readEvent(directory, task.taskId, 'startupFailure')) {
        recordEvent(directory, task.taskId, 'startupFailure', failureDetail);
      }
    });
    record(() => {
      recordEvent(directory, task.taskId, 'cleanup', { detail, stopped });
    });
    record(() => {
      outcome = taskStatus(directory, this.ownerId, false).outcome;
    });

    return outcome;
  }

  private notifyCleanup(
    handle: Handle,
    outcome: string,
    record: (operation: () => void) => void,
  ): void {
    if (this.closed) {
      return;
    }

    const { directory, task } = handle;

    record(() => {
      recordEvent(directory, task.taskId, 'notified', 'Parent notification attempted once.');
    });
    const errors = handle.recordErrors.length
      ? ` Evidence errors: ${handle.recordErrors.join('; ')}. Check pane ${handle.paneId ?? 'unknown'} manually.`
      : '';

    this.notify(
      `Worker ${task.name ?? 'unnamed'} (${task.taskId}): ${outcome}. ${handle.cleanupDetail}${errors} Records: ${directory}. ${nativeDescription(task, directory)}`,
    );
  }

  // Cleanup for every worker this controller still owns, so a stopping ancestor does not strand its tree.
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.handles.values()].map((handle) => this.stop(handle, 'cancelled')),
    );
    this.close();
  }

  close(): void {
    if (this.closed) {
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
