import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { descendantReservations } from './admission.js';
import { ensureReplyActive, workBudget } from './controllerBudget.js';
import { agentPromptArguments, herdrClient, inspectWorker } from './controllerInspect.js';
import type { HerdrClient } from './controllerInspect.js';
import { genericStatus, nativeDescription, taskStatus } from './controllerRecord.js';
import type { Handle } from './controllerTypes.js';
import { readGenericSubmission, submitGenericText } from './generic.js';
import { authenticateParent, currentProcessIdentity } from './identity.js';
import { WorkerPlacement } from './placement.js';
import {
  acceptReply,
  readAcknowledgement,
  readPendingQuestion,
  readQuestion,
  readReply,
} from './questionRecords.js';
import { readEvent, readTask } from './records.js';
import { resolveTerminal, text } from './terminal.js';
import { isGenericLoadout } from './types.js';
import type { Question, Task } from './types.js';

const acceptedReply = (directory: string, taskId: string, questionId: string) => ({
  replyAccepted: true,
  workerAcknowledged: Boolean(readAcknowledgement(directory, taskId, questionId)),
  delivery: 'Not retried. Prior delivery may be uncertain.',
});

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

export abstract class WorkerControllerStatus {
  readonly ownerId = randomUUID();
  protected readonly handles = new Map<string, Handle>();
  protected readonly admitted = new Map<string, Task>();
  protected readonly lifetime = new AbortController();
  protected readonly placement = new WorkerPlacement();
  protected closed = false;

  constructor(
    protected readonly root: string,
    protected readonly client: HerdrClient = herdrClient,
    protected readonly notify: (message: string, question?: Question) => void = () => undefined,
  ) {}

  protected abstract stop(
    handle: Handle,
    reason: 'timeout' | 'cancelled' | 'completion' | 'failure',
    failureDetail?: string,
  ): Promise<void>;

  async parentAuthority(parentSession: string, parentSessionId: string, signal?: AbortSignal) {
    const identity = await currentProcessIdentity(signal);
    // oxlint-disable-next-line node/no-process-env -- The locator is checked against session and parent-owned process evidence.
    const locator = process.env.TAU_WORKER_RECORD;

    return authenticateParent(
      this.root,
      { file: parentSession, id: parentSessionId },
      identity,
      locator,
    );
  }

  children() {
    const active = [...this.handles.values()].filter((handle) => !handle.cleanupFinished);
    const reservations = new Map(this.admitted);
    const uncertain: string[] = [];

    for (const task of this.admitted.values()) {
      try {
        for (const descendant of descendantReservations(this.root, task)) {
          reservations.set(descendant.taskId, descendant);
        }
      } catch (error) {
        uncertain.push(
          `Child ${task.taskId}: descendant evidence unavailable. Inspect ${join(this.root, task.taskId)} manually. ${String(error)}`,
        );
      }
    }

    for (const task of reservations.values()) {
      if (active.some((handle) => handle.task.taskId === task.taskId)) {
        continue;
      }

      const directory = join(this.root, task.taskId);

      try {
        if (readEvent(directory, task.taskId, 'cleanup')?.stopped === true) {
          continue;
        }
      } catch {
        // Missing or corrupt cleanup evidence cannot free a reservation or imply stopped work.
      }

      uncertain.push(
        `Child ${task.taskId}: cleanup unconfirmed; reservation retained. Inspect ${directory} manually.`,
      );
    }

    return { active: active.length, uncertain };
  }

  status(taskId: string, parentSessionId: string) {
    let handle: Handle | undefined;
    let task: Task | undefined;
    let directory = join(this.root, taskId);

    try {
      directory = this.directory(taskId, parentSessionId);
      handle = this.handles.get(taskId);
      task = handle ? handle.task : readTask(directory);

      if (handle?.recordErrors.length) {
        throw new Error(handle.recordErrors.join('; '));
      }

      return {
        ...taskStatus(
          directory,
          this.closed || !handle ? undefined : this.ownerId,
          !handle?.stopping,
        ),
        ...genericStatus(directory, task, handle),
      };
    } catch (error) {
      return this.statusFailure({ taskId, directory, handle, task, error });
    }
  }

  private statusFailure(request: StatusFailureRequest): never {
    // The handle is assigned only after the parent-session check; rejected callers cannot stop work.
    const { taskId, directory, handle, task, error } = request;

    if (handle && !this.closed) {
      void this.stop(handle, 'failure', `Worker evidence unavailable: ${String(error)}. No retry.`);
    }

    const native = task
      ? nativeDescription(task, directory)
      : 'Native session unavailable; inspect the saved directory.';

    throw new Error(
      `Worker ${taskId}: saved evidence is unavailable: ${String(error)}. ${handle?.cleanupDetail ?? 'Cleanup unconfirmed.'} Check pane ${handle?.paneId ?? 'unknown'} manually. Records: ${directory}. ${native}`,
      { cause: error },
    );
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

    const call = (argumentsList: string[]) =>
      this.client(argumentsList, workBudget(handle), handle.abort.signal);
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
    const hasStructuredQuestion = answer.questionId !== undefined;
    const reusedReplyId = answer.replyId === 'assignment';
    const invalidText = !answer.reply.trim() || answer.reply.length > 32_000;

    if (hasStructuredQuestion || reusedReplyId || invalidText) {
      throw new Error(
        'Generic replies use a unique replyId and plain text, without a structured questionId.',
      );
    }

    const { directory, task } = handle;
    const call = (argumentsList: string[]) =>
      this.client(argumentsList, workBudget(handle), handle.abort.signal);
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

    return submitGenericText(directory, task, {
      id: answer.replyId,
      text: answer.reply,
      send: () => {
        ensureReplyActive(handle);

        return call(agentPromptArguments(location.paneId, answer.reply));
      },
    });
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

    if (!answer.questionId) {
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

      return acceptedReply(directory, taskId, questionId);
    }

    if (readPendingQuestion(directory, taskId)?.questionId !== questionId) {
      throw new Error('Reply does not match the pending question.');
    }

    const call = (argumentsList: string[]) =>
      this.client(argumentsList, workBudget(handle), handle.abort.signal);
    const worker = await inspectWorker(handle, call);
    const location = await resolveTerminal(worker.terminalId, call);

    if (location.paneId !== worker.paneId) {
      throw new Error('Worker moved during identity checks; no input sent.');
    }

    ensureReplyActive(handle);

    // Another caller may have accepted this reply during the identity check. Never send it twice.
    if (readReply(directory, taskId, questionId)) {
      acceptReply(directory, taskId, value);

      return acceptedReply(directory, taskId, questionId);
    }

    return this.sendPiReply({ directory, handle, questionId, answer, value });
  }

  private async sendPiReply(request: PiReplyRequest) {
    const { directory, handle, questionId, answer, value } = request;
    const { taskId } = handle.task;
    const reference = { version: 1, taskId, questionId, replyId: answer.replyId };
    const delivery = `TAU_REPLY ${JSON.stringify(reference)}`;
    const call = (argumentsList: string[]) =>
      this.client(argumentsList, workBudget(handle), handle.abort.signal);

    acceptReply(directory, taskId, value);

    try {
      await call(['agent', 'prompt', text(handle.paneId), delivery]);
    } catch (error) {
      throw new Error(
        'Reply accepted durably, but delivery is uncertain. Do not retry delivery; inspect acknowledgement.',
        { cause: error },
      );
    }

    return {
      replyAccepted: true,
      workerAcknowledged: Boolean(readAcknowledgement(directory, taskId, questionId)),
      delivery:
        'Herdr accepted text. This does not prove worker acknowledgement or applied effects.',
    };
  }

  async cancel(taskId: string, parentSessionId: string) {
    this.directory(taskId, parentSessionId);
    const handle = this.handles.get(taskId);

    if (!handle || this.closed) {
      throw new Error(
        'No active owned handle. Use saved pane and native references for manual cleanup.',
      );
    }

    await this.stop(handle, 'cancelled');

    return this.status(taskId, parentSessionId);
  }

  private directory(taskId: string, parentSessionId: string): string {
    if (!/^[a-zA-Z0-9-]+$/.test(taskId)) {
      throw new Error('Invalid task identity.');
    }

    const directory = join(this.root, taskId);
    const task = this.handles.get(taskId)?.task ?? readTask(directory);

    if (task.parentSessionId !== parentSessionId) {
      throw new Error('Task belongs to another parent session.');
    }

    return directory;
  }
}
