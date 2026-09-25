import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext, SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

import { parseModelReference } from '../../../delegateModel/index.js';
import { errorMessage, isMissingFile } from '../../../errors/index.js';
import { processAbsent } from '../cancellation.js';
import { refuseLiveNativeWriter } from '../continuations.js';
import { submitGenericText, deliveryFromSubmission } from '../generic.js';
import { authorizeHistoryTask } from '../history.js';
import { validateSavedLoadout } from '../loadout.js';
import { allocateName, nameSuffix } from '../names.js';
import { validateNative } from '../native.js';
import { WorkerPlacement } from '../placement.js';
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
} from '../records.js';
import { resolveTerminal, text, requireObject, result } from '../terminal.js';
import type { TerminalCall } from '../terminal.js';
import { isGenericLoadout, isPiLoadout, isTaskId } from '../types.js';
import type { GenericLoadout, Task } from '../types.js';
import type { WorkerWidgetRow } from '../widget.js';
import {
  ensureReplyActive,
  workBudget,
  launchTiming,
  remainingLaunchBudget,
  remainingWorkBudget,
} from './budget.js';
import {
  agentPromptArguments,
  herdrClient,
  inspectWorker,
  observeWorker,
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
  readOwnedWorker,
} from './record.js';
import { waitForShell, integer, isBareShell, readProcessStart } from './shellIdentity.js';
import { createHandle, TaskController } from './task.js';
import type { TaskContext } from './task.js';
import type { Handle } from './types.js';
import { widgetRow } from './widgetRows.js';

interface PiReplyRequest {
  directory: string;
  worker: TaskController;
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

// Launch, replies, and cleanup share ownership state and one deadline. Keep their transitions together.
export class WorkerController {
  private readonly workers = new Map<string, TaskController>();
  private readonly capacity = workerCapacity();
  private readonly live = new Set<string>();
  private readonly lifetime = new AbortController();
  private readonly placement = new WorkerPlacement();
  private readonly taskContext: TaskContext;
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly client: HerdrClient = herdrClient,
    notify: (notice: WorkerNotice) => void = () => undefined,
  ) {
    this.taskContext = {
      client,
      notify,
      placement: this.placement,
      lifetime: this.lifetime.signal,
      closed: () => this.closed,
      owns: (taskId) => this.owns(taskId),
      release: (taskId) => {
        this.live.delete(taskId);
      },
    };
  }

  widgetRows(parentSessionId: string): WorkerWidgetRow[] {
    const rows: WorkerWidgetRow[] = [];

    for (const { directory, task } of readTasks(this.root)) {
      if (task.parentSessionId !== parentSessionId) {
        continue;
      }

      const handle = this.workers.get(task.taskId)?.handle;

      rows.push(widgetRow(directory, task, this.owns(task.taskId), handle));
    }

    return rows.toSorted((left, right) => right.createdAt - left.createdAt);
  }

  status(taskId: string, parentSessionId: string) {
    const directory = this.statusDirectory(taskId, parentSessionId);
    let handle: Handle | undefined;
    let task: Task | undefined;

    try {
      handle = this.workers.get(taskId)?.handle;
      task = handle ? handle.task : readTask(directory);

      if (handle != null && handle.cleanup.recordErrors.length > 0) {
        throw new Error(handle.cleanup.recordErrors.join('; '));
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
    // Status only reports; subagent_cancel stops a worker whose evidence is unreadable.
    const { taskId, directory, handle, task, error } = request;
    const recovery = handle ? handleRecovery(handle) : savedRecovery(task, directory);
    const running = handle !== undefined && handle.cleanup.stopping === undefined;

    const detail =
      handle?.cleanup.detail ??
      (running ? 'The worker may still run; subagent_cancel stops it.' : undefined);

    throw new EvidenceUnavailableError({
      taskId,
      ...(task?.name === undefined ? {} : { name: task.name }),
      evidenceError: String(error),
      recovery,
      ...(detail === undefined ? {} : { cleanupDetail: detail }),
      ...(handle?.identity.paneId === undefined ? {} : { paneId: handle.identity.paneId }),
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
    const live = this.workers.get(taskId);

    if (!live || !isGenericLoadout(live.handle.task.loadout)) {
      throw new Error('Native output requires an active owned generic worker.');
    }

    const { handle } = live;

    if (this.closed || handle.cleanup.stopping) {
      throw new Error('Native output requires an active owned generic worker.');
    }

    const call = live.herdrCall();
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

  owns(taskId: string): boolean {
    return !this.closed && this.workers.has(taskId);
  }

  private savedHandle(directory: string, task: Task): Handle {
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
  }

  async resume(parentSessionId: string): Promise<void> {
    for (const { directory, task } of readTasks(this.root)) {
      const foreign = task.parentSessionId !== parentSessionId || this.workers.has(task.taskId);
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

    if (isGenericLoadout(task.loadout) && !handle.identity.owned?.nativeReference) {
      return;
    }

    // ponytail: PID reuse can make an exited worker look present, costing one identity-checked stop attempt.
    if (
      remainingWorkBudget(handle) <= 0 &&
      handle.identity.owned &&
      processAbsent(handle.identity.owned.processId)
    ) {
      return;
    }

    // Reserve capacity and expose saved ownership to shutdown before inspection can yield.
    // ponytail: one Pi process per parent session; add cross-process exclusion if concurrent resumes become supported.
    const worker = new TaskController(handle, this.taskContext);

    this.workers.set(task.taskId, worker);
    this.live.add(task.taskId);

    try {
      handle.identity.owned = await inspectWorker(handle, worker.herdrCall());
      this.lifetime.signal.throwIfAborted();
      worker.poll();
    } catch {
      // An expired budget fails the first herdr call; the reserved cleanup budget still stops the worker.
      if (remainingWorkBudget(handle) <= 0) {
        await worker.stop('timeout');

        return;
      }

      this.workers.delete(task.taskId);
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
    worker: TaskController,
    answer: { questionId?: string; replyId: string; reply: string },
  ) {
    requireGenericReplyShape(answer);
    const { handle } = worker;
    const { directory, task } = handle;
    const call = worker.herdrCall();

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

  async reply(
    taskId: string,
    parentSessionId: string,
    answer: { questionId?: string; replyId: string; reply: string; scopeUnchanged: unknown },
  ) {
    const directory = this.directory(taskId, parentSessionId);
    const worker = this.workers.get(taskId);

    if (!worker || this.closed || worker.handle.cleanup.stopping) {
      throw new Error('No active owned worker for this reply.');
    }

    const { handle } = worker;

    if (answer.scopeUnchanged !== true) {
      throw new Error('Replies cannot increase scope or change saved worker settings.');
    }

    ensureReplyActive(handle);

    if (isGenericLoadout(handle.task.loadout)) {
      return this.replyGeneric(worker, answer);
    }

    if (answer.questionId == null || answer.questionId === '') {
      throw new Error('Pi replies require a structured questionId.');
    }

    return this.replyPi(directory, worker, answer.questionId, answer);
  }

  private async replyPi(
    directory: string,
    worker: TaskController,
    questionId: string,
    answer: { replyId: string; reply: string },
  ) {
    const { handle } = worker;
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

    const call = worker.herdrCall();
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

    return this.sendPiReply({ directory, worker, questionId, answer, value });
  }

  private async sendPiReply(request: PiReplyRequest) {
    const { directory, worker, questionId, answer, value } = request;
    const { handle } = worker;
    const { taskId } = handle.task;
    const reference = { version: 1, taskId, questionId, replyId: answer.replyId };
    const prompt = `TAU_REPLY ${JSON.stringify(reference)}`;
    const call = worker.herdrCall();

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

  async cancel(taskId: string, parentSessionId: string) {
    const directory = this.directory(taskId, parentSessionId);

    if (this.closed) {
      throw new Error('Parent controller stopped.');
    }

    const live = this.workers.get(taskId);

    // A settled stop already released capacity; reserving it again would leak the slot.
    if (live?.handle.cleanup.stopping) {
      await live.handle.cleanup.stopping;

      return this.status(taskId, parentSessionId);
    }

    // A live handle is stopped even when its saved cleanup record is unreadable.
    if (!live && readEvent(directory, taskId, 'cleanup')) {
      return this.status(taskId, parentSessionId);
    }

    const worker =
      live ??
      new TaskController(this.savedHandle(directory, readTask(directory)), this.taskContext);

    this.workers.set(taskId, worker);
    this.live.add(taskId);
    await worker.stop('cancelled');

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
    const task = this.workers.get(taskId)?.handle.task ?? this.savedTask(directory);

    if (task.parentSessionId !== parentSessionId) {
      throw new TaskAccessError('Task belongs to another parent session.');
    }

    return directory;
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
          handle.identity.paneId = created.paneId;
          handle.identity.terminalId = created.terminalId;
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

  private async startAgent(worker: TaskController, paneId: string, name: string): Promise<void> {
    const { handle } = worker;
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
    const call = worker.herdrCall(signal);

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
    worker: TaskController,
    paneId: string,
    name: string,
    call: TerminalCall,
  ): Promise<void> {
    const { handle } = worker;

    try {
      await this.startAgent(worker, paneId, name);
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

      await this.startAgent(worker, paneId, name);
    }
  }

  private async startWorker(
    worker: TaskController,
    paneId: string,
    name: string,
    call: TerminalCall,
  ): Promise<void> {
    const { handle } = worker;
    const { task } = handle;
    const generic = isGenericLoadout(task.loadout) ? task.loadout : undefined;

    await this.prepareStart(handle, paneId, call, generic);

    await this.startWithBusyRetry(worker, paneId, name, call).catch((error: unknown) => {
      if (handle.startup.starting === undefined) {
        throw error;
      }

      handle.startup.error = String(error).slice(0, 4000);

      if (!generic) {
        throw error;
      }

      publish(handle.directory, 'nativeStart-error.json', { detail: handle.startup.error });
      worker.notifySnapshot({ failure: handle.startup.error });
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
      const ownedLocation = await resolveTerminal(text(handle.identity.terminalId), call);

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
    const { worker, name } = prepared;
    const { handle } = worker;

    try {
      launchSignal.throwIfAborted();
      workBudget(handle);

      const call = worker.herdrCall();
      const location = await this.placeWorker(input, handle, call);

      if (source) {
        checkHandoff(source);
      }

      await this.startWorker(worker, location.paneId, name, call);
      await this.finishStartup(worker, call);
      handle.removeLaunchAbort?.();

      await this.renameWorkerPane(handle);
    } catch (error) {
      const reason = remainingWorkBudget(handle) <= 0 ? 'timeout' : 'failure';

      await worker.stop(reason, this.startupFailureDetail(handle, error));
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
        const live = this.workers.get(id)?.handle.task;

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

    const worker = new TaskController(
      createHandle(directory, task, timing.expires),
      this.taskContext,
    );

    this.workers.set(taskId, worker);
    worker.arm(launchSignal);

    return { taskId, worker, name };
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

  private async finishStartup(worker: TaskController, call: TerminalCall): Promise<void> {
    const { handle } = worker;

    if (!isPiLoadout(handle.task.loadout)) {
      if (handle.startup.error !== undefined && (await verifyRejectedStart(handle, call))) {
        handle.startup.neverStarted = true;
        throw new Error(
          `Native startup was rejected by herdr absence evidence. No retry. ${handle.startup.error}`,
        );
      }

      await worker.pollGeneric();

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
    await worker.dispatch(call);
    worker.poll();
  }

  private startupFailureDetail(handle: Handle, error: unknown): string {
    if (handle.startup.starting === undefined) {
      return `No worker was started; no automatic retry. ${String(error)}`;
    }

    return handle.startup.error !== undefined && handle.startup.neverStarted
      ? `Native startup was rejected by herdr absence evidence; no retry. ${String(error)}`
      : `Startup delivery is uncertain; no automatic retry. ${String(error)}`;
  }

  // Freeze admission before snapshotting handles, but keep cleanup's lifetime signal active.
  async stopAll(reason: SessionShutdownEvent['reason'] = 'quit'): Promise<void> {
    this.closed = true;

    for (const worker of this.workers.values()) {
      worker.handle.cleanup.shutdownReason = reason;
    }

    await Promise.allSettled([...this.workers.values()].map((worker) => worker.stop('cancelled')));

    this.close();
  }

  close(): void {
    if (this.lifetime.signal.aborted) {
      return;
    }

    this.closed = true;
    this.lifetime.abort();

    for (const worker of this.workers.values()) {
      worker.close();
    }
  }
}
