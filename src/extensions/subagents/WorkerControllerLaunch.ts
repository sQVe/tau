import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { admissionDirectory, reserveTask } from './admission.js';
import { refuseLiveNativeWriter } from './continuations.js';
import {
  boundedTiming,
  launchTiming,
  remainingWorkBudget,
  treeCapacity,
  workBudget,
} from './controllerBudget.js';
import {
  agentPromptArguments,
  inspectWorker,
  integer,
  prepareTaskDirectory,
  readProcessStart,
  verifyRejectedStart,
  waitForWorkerReadiness,
  workerArguments,
} from './controllerInspect.js';
import {
  checkHandoff,
  checkNativeWriterListing,
  nativeReference,
  requireUnclaimed,
} from './controllerLaunchSupport.js';
import type { FollowUpPreparation, LaunchInput } from './controllerLaunchSupport.js';
import type { Handle } from './controllerTypes.js';
import { genericPrompt, readGenericSubmission, submitGenericText } from './generic.js';
import { authorizeHistoryTask } from './history.js';
import { validateSavedLoadout } from './loadout.js';
import { allocateName, nameSuffix } from './names.js';
import { validateNative } from './native.js';
import { claimSuccessor, publish, validateTask } from './records.js';
import { object, resolveTerminal, result } from './terminal.js';
import { isGenericLoadout, isPiLoadout } from './types.js';
import type { GenericLoadout, Task } from './types.js';
import { WorkerControllerStatus } from './WorkerControllerStatus.js';

interface LaunchTaskPlan {
  taskId: string;
  directory: string;
  createdAt: number;
  deadline: number;
  cancellationBudget: number;
  monotonicDeadline: number;
  tree: NonNullable<Task['tree']>;
  source?: FollowUpPreparation;
}

export abstract class WorkerControllerLaunch extends WorkerControllerStatus {
  protected abstract poll(handle: Handle): void;

  protected abstract pollGeneric(handle: Handle): Promise<void>;

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
      AbortSignal.timeout(
        Math.max(1, Math.floor(timing.expires - timing.cancellationBudget - performance.now())),
      ),
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

    requireUnclaimed(this.root, source);
    const native = validateNative(source.task, source.origin);
    const loadout = await validateSavedLoadout(source.task.loadout, context, validationSignal);
    validationSignal.throwIfAborted();
    requireUnclaimed(this.root, source);

    // Validation expiry must not masquerade as caller cancellation during launch/readiness.
    return this.launchTask({ ...input, loadout, startedAt }, signal, {
      ...source,
      native,
    });
  }

  private placeWorker(
    input: LaunchInput,
    handle: Handle,
    call: (argumentsList: string[]) => Promise<string>,
  ) {
    return this.placement.place(
      {
        ...(input.parentPane ? { parentPane: input.parentPane } : {}),
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
              `TAU_PARENT_PROCESS=${process.pid}`,
              `PI_CODING_AGENT_DIR=${handle.task.loadout.agentDirectory}`,
            ]
          : [],
      },
      call,
      handle.abort.signal,
    );
  }

  private async startWorker(
    handle: Handle,
    paneId: string,
    name: string,
    call: (argumentsList: string[]) => Promise<string>,
  ): Promise<void> {
    const { task } = handle;
    const generic = isGenericLoadout(task.loadout) ? task.loadout : undefined;

    if (generic) {
      await this.prepareGenericStart(handle, paneId, call, generic);
    }

    // A failing start call can still leave a process behind.
    handle.workerNeverStarted = false;
    await call([
      'agent',
      'start',
      name,
      '--kind',
      generic?.kind ?? 'pi',
      '--pane',
      paneId,
      '--timeout',
      String(workBudget(handle)),
      '--',
      ...(generic?.arguments ?? workerArguments(task)),
    ]).catch((error: unknown) => {
      if (!generic) {
        throw error;
      }

      handle.startError = String(error).slice(0, 4000);
      publish(handle.directory, 'nativeStart-error.json', { detail: handle.startError });
      this.notify(
        `Worker ${task.taskId}: native startup is blocked or uncertain. No start retry. ${handle.startError}`,
      );
    });
  }

  private async prepareGenericStart(
    handle: Handle,
    paneId: string,
    call: (argumentsList: string[]) => Promise<string>,
    generic: GenericLoadout,
  ): Promise<void> {
    const information = object(
      result(await call(['pane', 'process-info', '--pane', paneId])).process_info,
    );
    const shellPid = integer(information.shell_pid);

    if (information.pane_id !== paneId || information.foreground_process_group_id !== shellPid) {
      throw new Error('Native start requires an unchanged foreground shell.');
    }

    handle.shell = { processId: shellPid, startedAt: await readProcessStart(handle, shellPid) };

    if (!handle.shell.startedAt) {
      throw new Error('Shell start identity is unavailable.');
    }

    publish(handle.directory, 'shell.json', handle.shell);
    publish(handle.directory, 'nativeStart-intent.json', {
      taskId: handle.task.taskId,
      kind: generic.kind,
      arguments: generic.arguments,
      terminalId: handle.terminalId,
    });
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

  protected async dispatch(
    handle: Handle,
    call: (argumentsList: string[]) => Promise<string>,
  ): Promise<void> {
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

    this.notifyUndelivered(handle, submission?.observation);
  }

  private notifyUndelivered(
    handle: Handle,
    observation: { state?: string; detail?: string } | undefined,
  ): void {
    const undelivered =
      observation?.state === 'not-delivered' || observation?.state === 'uncertain';

    if (!handle.stopping && !this.closed && undelivered) {
      this.notify(
        `Worker ${handle.task.taskId}: assignment ${observation.state}. ${observation.detail} Inspect the native pane; no automatic retry. The original deadline remains active.`,
      );
    }
  }

  private async launchTask(
    input: LaunchInput,
    launchSignal: AbortSignal,
    source?: FollowUpPreparation,
  ): Promise<ReturnType<WorkerControllerStatus['status']>> {
    if (this.closed) {
      throw new Error('Parent controller stopped.');
    }

    launchSignal.throwIfAborted();
    const prepared = await this.prepareLaunch(input, launchSignal, source);
    const { handle, name } = prepared;

    try {
      launchSignal.throwIfAborted();
      workBudget(handle);

      if (source) {
        claimSuccessor(source.directory, handle.task);
        checkHandoff(this.root, source, handle.task);
      }

      const call = (argumentsList: string[]) =>
        this.client(argumentsList, workBudget(handle), handle.abort.signal);
      const location = await this.placeWorker(input, handle, call);

      if (source) {
        checkNativeWriterListing(await call(['agent', 'list']), handle.task);
        checkHandoff(this.root, source, handle.task);
      }

      await this.startWorker(handle, location.paneId, name, call);
      await this.finishStartup(handle, call);
      handle.removeLaunchAbort?.();
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
    const authority = await this.parentAuthority(
      input.parentSession,
      input.parentSessionId,
      launchSignal,
    );
    const bounded = boundedTiming(timing, authority.parent);

    if (authority.parent && isGenericLoadout(input.loadout)) {
      throw new Error(
        'Generic workers require root-parent approval and have no Tau nesting channel.',
      );
    }

    const task = this.buildTask(input, {
      taskId,
      directory,
      createdAt: bounded.createdAt,
      deadline: bounded.deadline,
      cancellationBudget: bounded.cancellationBudget,
      monotonicDeadline: bounded.monotonicDeadline,
      tree: authority.tree,
      ...(source ? { source } : {}),
    });
    const listing = await this.readAgentListing(launchSignal, bounded);

    this.checkFollowUpSource(input.loadout, listing.agents, source);
    // Synchronous allocation and publication after listing coordinate launches in this process's event loop,
    // not launches in independent processes.
    const name = allocateName({
      root: this.root,
      parentSessionId: input.parentSessionId,
      role: input.loadout.role,
      live: listing.agents,
      suffix: nameSuffix,
    });
    task.name = name;
    validateTask(task);

    // The reservation precedes task publication, native opening, and successor claims.
    this.reserveAndPublish(task, authority.tree, Boolean(source));

    const handle = this.createHandle(directory, task, bounded.expires);
    this.handles.set(taskId, handle);
    this.armHandle(handle, launchSignal);

    return { taskId, handle, name };
  }

  private async readAgentListing(
    launchSignal: AbortSignal,
    bounded: ReturnType<typeof boundedTiming>,
  ) {
    const remaining = Math.floor(bounded.expires - bounded.cancellationBudget - performance.now());
    const listingSignal = AbortSignal.any([
      launchSignal,
      this.lifetime.signal,
      AbortSignal.timeout(Math.max(1, remaining)),
    ]);
    const listing = result(
      await this.client(['agent', 'list'], Math.min(30_000, remaining), listingSignal),
    );
    listingSignal.throwIfAborted();

    if (
      listing.type !== 'agent_list' ||
      performance.now() >= bounded.expires - bounded.cancellationBudget
    ) {
      throw new Error('Invalid live agent listing or original startup budget expired.');
    }

    return listing;
  }

  private reserveAndPublish(task: Task, tree: NonNullable<Task['tree']>, continued: boolean): void {
    reserveTask(this.root, task, treeCapacity());
    this.admitted.set(task.taskId, task);
    prepareTaskDirectory(join(this.root, task.taskId), task, continued, () =>
      admissionDirectory(this.root, tree),
    );
  }

  private buildTask(input: LaunchInput, plan: LaunchTaskPlan): Task {
    return validateTask({
      version: isGenericLoadout(input.loadout) ? 2 : 1,
      name: `${input.loadout.role === 'editing' ? 'worker' : 'investigator'}-00`,
      taskId: plan.taskId,
      task: input.task,
      parentSession: input.parentSession,
      parentSessionId: input.parentSessionId,
      ownerId: this.ownerId,
      ...nativeReference(input.loadout, plan.directory, plan.source),
      createdAt: plan.createdAt,
      deadline: plan.deadline,
      cancellationBudget: plan.cancellationBudget,
      tree: { ...plan.tree, monotonicDeadline: plan.monotonicDeadline },
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
      Math.max(1, handle.expires - handle.task.cancellationBudget - performance.now()),
    );
  }

  private async finishStartup(
    handle: Handle,
    call: (argumentsList: string[]) => Promise<string>,
  ): Promise<void> {
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

    handle.owned = await inspectWorker(handle, call);
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
    return handle.startError !== undefined && handle.workerNeverStarted
      ? `Native startup was rejected by herdr absence evidence; no retry. ${String(error)}`
      : `Startup delivery is uncertain; no retry. ${String(error)}`;
  }
}
