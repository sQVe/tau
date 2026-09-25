import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext, SessionShutdownEvent } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from '../../../errors/index.js';
import { processAbsent } from '../cancellation.js';
import { refuseLiveNativeWriter } from '../continuations.js';
import { authorizeHistoryTask } from '../history.js';
import { validateSavedLoadout } from '../loadout.js';
import { allocateName, nameSuffix } from '../names.js';
import { validateNative } from '../native.js';
import { WorkerPlacement } from '../placement.js';
import type { WorkerNotice } from '../presentation.js';
import { readAcknowledgement, readQuestion, readReply } from '../questionRecords.js';
import {
  readEvent,
  readGenericSubmission,
  readTask,
  readTasks,
  namePrefix,
  publish,
  validateTask,
} from '../records.js';
import { result } from '../terminal.js';
import type { TerminalCall } from '../terminal.js';
import { isGenericLoadout, isPiLoadout, isTaskId } from '../types.js';
import type { Task } from '../types.js';
import type { WorkerWidgetRow } from '../widget.js';
import {
  ensureReplyActive,
  workBudget,
  launchTiming,
  remainingLaunchBudget,
  remainingWorkBudget,
} from './budget.js';
import { herdrClient, inspectWorker, prepareTaskDirectory } from './inspect.js';
import type { HerdrClient } from './inspect.js';
import { checkHandoff, nativeReference, requireUnclaimed } from './launchSupport.js';
import type { FollowUpPreparation, LaunchInput } from './launchSupport.js';
import {
  EvidenceUnavailableError,
  genericStatus,
  handleRecovery,
  savedRecovery,
  taskStatus,
} from './record.js';
import { createHandle, savedHandle, TaskController } from './task.js';
import type { TaskContext } from './task.js';
import type { Handle } from './types.js';
import { widgetRow } from './widgetRows.js';

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

// A caller asked for a task it may not read; this is a refusal, never unreadable evidence.
class TaskAccessError extends Error {
  override name = 'TaskAccessError';
}

// Registry, capacity, launch allocation, and ownership checks for all workers; each worker runs its own lifecycle.
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

    if (this.closed || live.handle.cleanup.stopping) {
      throw new Error('Native output requires an active owned generic worker.');
    }

    return live.nativeOutput();
  }

  owns(taskId: string): boolean {
    return !this.closed && this.workers.has(taskId);
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
    const handle = savedHandle(directory, task);

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

    return worker.reply(directory, answer);
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
      live ?? new TaskController(savedHandle(directory, readTask(directory)), this.taskContext);

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

      await worker.start(location.paneId, name, call);
    } catch (error) {
      const reason = remainingWorkBudget(handle) <= 0 ? 'timeout' : 'failure';

      await worker.stop(reason, worker.startupFailureDetail(error));
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
