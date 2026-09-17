import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { cancelOwnedWorker, matchesWorker, runClient } from './cancellation.js';
import type { OwnedWorker } from './cancellation.js';
import { requireHandover, refuseLiveNativeWriter } from './continuations.js';
import { authorizeHistoryTask } from './history.js';
import { validateSavedLoadout } from './loadout.js';
import { allocateName, nameSuffix } from './names.js';
import { validateNative } from './native.js';
import { nativeIdentity, seedSession } from './profiles.js';
import {
  acceptReply,
  claimSuccessor,
  publish,
  readAcknowledgement,
  readEvent,
  readPendingQuestion,
  readQuestion,
  readReply,
  readReport,
  readTask,
  readTasks,
  readSuccessor,
  recordEvent,
  validateTask,
} from './records.js';
import type { Loadout, Question, Report, Task, TaskEvent } from './types.js';

export type HerdrClient = (
  arguments_: string[],
  budget: number,
  signal?: AbortSignal,
) => Promise<string>;
export const herdrClient: HerdrClient = (arguments_, budget, signal) =>
  runClient('herdr', arguments_, budget, signal);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) {
    throw new Error('Malformed herdr response.');
  }

  return value;
};
const result = (response: string): Record<string, unknown> => {
  return object(object(JSON.parse(response)).result);
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value) {
    throw new Error('Missing herdr identity.');
  }

  return value;
};
const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error('Invalid herdr process identity.');
  }

  return Number(value);
};
const processAbsent = (processId: number): boolean => {
  try {
    process.kill(processId, 0);

    return false;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH';
  }
};

export const workerArguments = (task: Task): string[] => {
  const separator = task.loadout.model.indexOf('/');

  return [
    '--approve',
    '--session',
    task.nativeSessionFile,
    '--provider',
    task.loadout.model.slice(0, separator),
    '--model',
    task.loadout.model.slice(separator + 1),
    '--thinking',
    task.loadout.thinking,
    // Pi keeps explicit -e entries with --no-extensions. Replay the validated set without rediscovering packages or another Tau checkout.
    '--no-extensions',
    ...task.loadout.integrations.flatMap((path) => ['-e', path]),
    '-e',
    fileURLToPath(new URL('./worker.ts', import.meta.url)),
  ];
};

const taskOutcome = (
  events: (TaskEvent | undefined)[],
  report: Report | undefined,
  incomplete: boolean,
): string => {
  const terminal = events.find((event) => event !== undefined);
  if (terminal) {
    return terminal.kind === 'startupFailure' ? 'failure' : terminal.kind;
  }

  return report?.outcome ?? (incomplete ? 'incomplete' : 'running');
};

export const taskStatus = (directory: string, activeOwner?: string, enforcing = true) => {
  const task = readTask(directory);
  const report = readReport(directory, task.taskId);
  const event = (kind: TaskEvent['kind']) => readEvent(directory, task.taskId, kind);
  const timeout = event('timeout');
  const cancelled = event('cancelled');
  const failure = event('startupFailure');
  const settled = event('settled');
  const cleanup = event('cleanup');
  const active = enforcing && activeOwner === task.ownerId && !cleanup && !timeout && !cancelled;
  const outcome = taskOutcome([timeout, cancelled, failure], report, Boolean(settled) || !active);

  return {
    taskId: task.taskId,
    name: task.name,
    predecessorTaskId: task.predecessorTaskId,
    successorTaskId: readSuccessor(directory)?.successorTaskId,
    outcome,
    ready: !!event('ready'),
    accepted: !!event('accepted'),
    reportAccepted: !!report,
    ownedByThisParent: activeOwner === task.ownerId,
    deadlineActive: active,
    stopped: !!settled?.stopped || !!cleanup?.stopped,
    deadline: task.deadline,
    nativeSessionId: task.nativeSessionId,
    nativeSessionFile: task.nativeSessionFile,
    directory,
    report,
    pendingQuestion: readPendingQuestion(directory, task.taskId),
    failure: failure?.detail,
    cleanup: cleanup?.detail,
    enforcement: active
      ? 'Original parent deadline remains active.'
      : 'No active owner in this parent. Saved evidence only; work may still be running. Check the saved pane manually. No retry or continuing enforcement is promised.',
  };
};

interface Handle {
  directory: string;
  task: Task;
  owned?: OwnedWorker;
  paneId?: string;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  abort: AbortController;
  expires: number;
  removeLaunchAbort?: () => void;
  recordErrors: string[];
  cleanupDetail?: string;
  notifiedQuestions: Set<string>;
}

const workBudget = (handle: Handle, maximum = 30_000): number => {
  handle.abort.signal.throwIfAborted();
  const remaining = Math.floor(handle.expires - handle.task.cancellationBudget - performance.now());
  if (remaining <= 0) {
    throw new Error('The original worker startup budget expired.');
  }

  return Math.min(maximum, remaining);
};

const ensureReplyActive = (handle: Handle): void => {
  workBudget(handle);
  const { directory, task } = handle;
  if (
    !readEvent(directory, task.taskId, 'accepted') ||
    (['settled', 'startupFailure', 'cleanup', 'cancelled', 'timeout'] as const).some((kind) =>
      readEvent(directory, task.taskId, kind),
    ) ||
    readReport(directory, task.taskId)
  ) {
    throw new Error('Worker task is inactive.');
  }
};

const inspectWorker = async (
  handle: Handle,
  call: (arguments_: string[]) => Promise<string>,
): Promise<OwnedWorker> => {
  const paneId = text(handle.paneId);
  const information = object(
    result(await call(['pane', 'process-info', '--pane', paneId])).process_info,
  );
  const previous = handle.owned;
  if (
    information.pane_id === paneId &&
    information.foreground_process_group_id === information.shell_pid &&
    (!previous ||
      (information.shell_pid === previous.shellPid && processAbsent(previous.processId)))
  ) {
    throw new Error('Worker exited before readiness. No task dispatch or retry.');
  }

  const agent = object(result(await call(['agent', 'get', paneId])).agent);
  const processId = integer(information.foreground_process_group_id);
  const shellPid = integer(information.shell_pid);
  if (
    agent.pane_id !== paneId ||
    agent.agent !== 'pi' ||
    object(agent.agent_session).value !== handle.task.nativeSessionFile ||
    shellPid === processId
  ) {
    throw new Error('Started worker identity could not be established.');
  }

  const processStart = await runClient(
    'ps',
    ['-p', String(processId), '-o', 'lstart='],
    workBudget(handle, 1000),
    handle.abort.signal,
  );
  const startedAt = processStart.trim();
  const owned: OwnedWorker = previous ?? {
    kind: 'pi',
    paneId,
    shellPid,
    processId,
    token: handle.task.nativeSessionFile,
    startedAt,
  };
  if (!startedAt || startedAt !== owned.startedAt || !matchesWorker(information, owned)) {
    throw new Error('Worker process start or pane identity changed or is unavailable.');
  }

  return owned;
};

const waitForWorkerReadiness = async (
  handle: Handle,
  call: (arguments_: string[]) => Promise<string>,
): Promise<TaskEvent> => {
  for (;;) {
    handle.abort.signal.throwIfAborted();
    const failure = readEvent(handle.directory, handle.task.taskId, 'startupFailure');
    if (failure) {
      throw new Error(failure.detail);
    }
    const ready = readEvent(handle.directory, handle.task.taskId, 'ready');
    if (ready) {
      return ready;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Detect death and changed identity before readiness within the same startup budget.
    await inspectWorker(handle, call);

    // oxlint-disable-next-line eslint/no-await-in-loop -- Readiness remains inside the original deadline and cancellation signal.
    await delay(Math.min(250, workBudget(handle)), undefined, { signal: handle.abort.signal });
  }
};

const launchTiming = (timeout: number, startedAt?: { wall: number; monotonic: number }) => {
  const createdAt = startedAt?.wall ?? Date.now();
  const expires = (startedAt?.monotonic ?? performance.now()) + timeout;
  const cancellationBudget = Math.min(5000, Math.floor(timeout / 4));
  if (!Number.isFinite(expires) || performance.now() >= expires - cancellationBudget) {
    throw new Error('The original task work budget expired during loadout resolution.');
  }

  return {
    createdAt,
    deadline: createdAt + timeout,
    expires,
    cancellationBudget,
  };
};

interface LaunchInput {
  task: string;
  loadout: Loadout;
  timeout: number;
  parentSession: string;
  parentSessionId: string;
  parentPane: string;
  startedAt?: { wall: number; monotonic: number };
}

interface FollowUpPreparation {
  directory: string;
  task: Task;
  origin: Task;
  native: ReturnType<typeof validateNative>;
}

const requireUnclaimed = (root: string, source: { directory: string; task: Task }): void => {
  const claim = readSuccessor(source.directory);
  const pending = readTasks(root).find(({ task }) => task.predecessorTaskId === source.task.taskId);
  const successor = claim?.successorTaskId ?? pending?.task.taskId;
  if (successor) {
    throw new Error(
      `Task ${source.task.taskId} already has successor attempt ${successor}. No retry or age-based reclaim.`,
    );
  }
  requireHandover(source.directory, source.task);
};

const checkHandoff = (root: string, source: FollowUpPreparation, successor: Task): void => {
  authorizeHistoryTask(
    root,
    { file: successor.parentSession, id: successor.parentSessionId },
    source.task.taskId,
  );
  if (
    !isDeepStrictEqual(readTask(source.directory), source.task) ||
    readSuccessor(source.directory)?.successorTaskId !== successor.taskId
  ) {
    throw new Error(`Successor ${successor.taskId} no longer owns its predecessor claim.`);
  }
  requireHandover(source.directory, source.task);
  if (!isDeepStrictEqual(validateNative(source.task, source.origin), source.native)) {
    throw new Error('Native file changed during follow-up validation. Claim retained; no retry.');
  }
};

const checkNativeWriterListing = (response: string, task: Task): void => {
  const live = result(response);
  if (live.type !== 'agent_list') {
    throw new Error('Malformed live native writer listing.');
  }
  refuseLiveNativeWriter(live.agents, task);
};

export class WorkerController {
  readonly ownerId = randomUUID();
  private readonly handles = new Map<string, Handle>();
  private readonly lifetime = new AbortController();
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly client: HerdrClient = herdrClient,
    private readonly notify: (message: string, question?: Question) => void = () => undefined,
  ) {}

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
    requireUnclaimed(this.root, source);
    const native = validateNative(source.task, source.origin);
    const loadout = await validateSavedLoadout(source.task.loadout, context, validationSignal);
    validationSignal.throwIfAborted();
    requireUnclaimed(this.root, source);

    // Validation expiry must not masquerade as caller cancellation during launch/readiness.
    return this.launchTask({ ...input, loadout, startedAt }, signal, { ...source, native });
  }

  private async launchTask(
    input: LaunchInput,
    launchSignal: AbortSignal,
    source?: FollowUpPreparation,
  ): Promise<ReturnType<typeof taskStatus>> {
    if (this.closed) {
      throw new Error('Parent controller stopped.');
    }
    launchSignal.throwIfAborted();
    const taskId = randomUUID();
    const directory = join(this.root, taskId);
    const { createdAt, deadline, expires, cancellationBudget } = launchTiming(
      input.timeout,
      input.startedAt,
    );
    const task = validateTask({
      version: 1,
      name: `${input.loadout.role === 'editing' ? 'worker' : 'investigator'}-00`,
      taskId,
      task: input.task,
      parentSession: input.parentSession,
      parentSessionId: input.parentSessionId,
      ownerId: this.ownerId,
      ...(source
        ? {
            predecessorTaskId: source.task.taskId,
            nativeSessionId: source.task.nativeSessionId,
            nativeSessionFile: source.task.nativeSessionFile,
          }
        : nativeIdentity(directory)),
      createdAt,
      deadline,
      cancellationBudget,
      loadout: input.loadout,
    });
    const remaining = Math.floor(expires - cancellationBudget - performance.now());
    const listingSignal = AbortSignal.any([
      launchSignal,
      this.lifetime.signal,
      AbortSignal.timeout(Math.max(1, remaining)),
    ]);
    const listing = result(
      await this.client(['agent', 'list'], Math.min(30_000, remaining), listingSignal),
    );
    listingSignal.throwIfAborted();
    if (listing.type !== 'agent_list' || performance.now() >= expires - cancellationBudget) {
      throw new Error('Invalid live agent listing or original startup budget expired.');
    }
    if (source) {
      requireUnclaimed(this.root, source);
      refuseLiveNativeWriter(listing.agents, source.task);
      if (!isDeepStrictEqual(input.loadout, source.task.loadout)) {
        throw new Error('Follow-up cannot change saved worker settings.');
      }
    }
    // Synchronous allocation and publication after listing coordinate launches in this process's event loop,
    // not launches in independent processes.
    const name = allocateName(
      this.root,
      input.parentSessionId,
      input.loadout.role,
      listing.agents,
      nameSuffix,
    );
    task.name = name;
    validateTask(task);

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      publish(directory, 'task.json', task);
      if (!source) {
        seedSession(task);
      }
    } catch (error) {
      throw new Error(
        `Task preparation ${taskId} is uncertain at ${directory}. No automatic retry.`,
        { cause: error },
      );
    }

    const handle: Handle = {
      directory,
      task,
      abort: new AbortController(),
      expires,
      recordErrors: [],
      notifiedQuestions: new Set(),
    };
    this.handles.set(taskId, handle);

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
      Math.max(1, expires - task.cancellationBudget - performance.now()),
    );

    try {
      launchSignal.throwIfAborted();
      workBudget(handle);
      if (source) {
        claimSuccessor(source.directory, task);
        checkHandoff(this.root, source, task);
      }
      const call = (arguments_: string[]) =>
        this.client(arguments_, workBudget(handle), handle.abort.signal);
      const split = result(
        await call([
          'pane',
          'split',
          '--pane',
          input.parentPane,
          '--direction',
          'right',
          '--cwd',
          task.loadout.cwd,
          '--no-focus',
          '--env',
          `TAU_WORKER_RECORD=${directory}`,
          '--env',
          `PI_CODING_AGENT_DIR=${task.loadout.agentDirectory}`,
        ]),
      );
      handle.paneId = text(object(split.pane).pane_id);
      publish(directory, 'pane.json', { paneId: handle.paneId });
      if (source) {
        checkNativeWriterListing(await call(['agent', 'list']), task);
        checkHandoff(this.root, source, task);
      }
      await call([
        'agent',
        'start',
        name,
        '--kind',
        'pi',
        '--pane',
        handle.paneId,
        '--timeout',
        String(workBudget(handle)),
        '--',
        ...workerArguments(task),
      ]);
      handle.owned = await inspectWorker(handle, call);
      publish(directory, 'owned.json', handle.owned);
      const ready = await waitForWorkerReadiness(handle, call);
      const current = await inspectWorker(handle, call);
      if (ready.processId !== current.processId) {
        throw new Error('Native session and worker readiness identities did not match.');
      }
      handle.abort.signal.throwIfAborted();
      publish(directory, 'dispatch.json', { taskId });
      this.poll(handle);
      handle.removeLaunchAbort();
    } catch (error) {
      const reason =
        performance.now() >= handle.expires - task.cancellationBudget ? 'timeout' : 'failure';
      await this.stop(handle, reason, `Startup delivery is uncertain; no retry. ${String(error)}`);
    }

    return this.status(taskId, input.parentSessionId);
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
        try {
          if (performance.now() >= handle.expires - handle.task.cancellationBudget) {
            void this.stop(handle, 'timeout');
            return;
          }
          if (
            readEvent(handle.directory, handle.task.taskId, 'settled') ||
            readEvent(handle.directory, handle.task.taskId, 'startupFailure') ||
            (handle.owned !== undefined && processAbsent(handle.owned.processId))
          ) {
            void this.stop(handle, 'completion');
            return;
          }
          const question = readPendingQuestion(handle.directory, handle.task.taskId);
          if (question && !handle.notifiedQuestions.has(question.questionId)) {
            handle.notifiedQuestions.add(question.questionId);
            this.notify(
              `Worker ${handle.task.name ?? 'unnamed'} (${handle.task.taskId}) asks: ${question.question}\nReply with subagent_reply using questionId ${question.questionId}. The original deadline still applies.`,
              question,
            );
          }
          this.poll(handle);
        } catch (error) {
          void this.stop(
            handle,
            'failure',
            `Worker evidence unavailable: ${String(error)}. No retry.`,
          );
        }
      },
      Math.max(
        1,
        Math.min(250, handle.expires - handle.task.cancellationBudget - performance.now()),
      ),
    );
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
    handle.stopping = this.cleanup(handle, reason, failureDetail).catch((error: unknown) => {
      handle.recordErrors.push(String(error));
      if (this.closed) {
        return;
      }
      this.notify(
        `Worker ${handle.task.name ?? 'unnamed'} (${handle.task.taskId}): cleanup unconfirmed. ${String(error)}. Check pane ${handle.paneId ?? 'unknown'} manually. Records: ${handle.directory}. Native session: ${handle.task.nativeSessionId} (${handle.task.nativeSessionFile}).`,
      );
    });

    return handle.stopping;
  }

  private async cleanup(
    handle: Handle,
    reason: 'timeout' | 'cancelled' | 'completion' | 'failure',
    failureDetail: string,
  ): Promise<void> {
    const { directory, task, owned } = handle;
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
    const call = (arguments_: string[]) => this.client(arguments_, remainingBudget(), signal);
    let stopped = false;
    let detail = `Cleanup unconfirmed. Check pane ${handle.paneId ?? 'unknown'} manually. No automatic retry.`;

    if (owned) {
      const shellIsOwned = async () => {
        const information = object(
          result(await call(['pane', 'process-info', '--pane', owned.paneId])).process_info,
        );

        return (
          information.pane_id === owned.paneId &&
          information.shell_pid === owned.shellPid &&
          information.foreground_process_group_id === owned.shellPid &&
          processAbsent(owned.processId)
        );
      };
      try {
        stopped = await shellIsOwned();
        signal.throwIfAborted();
        if (!stopped) {
          const cancellation = await cancelOwnedWorker(
            owned,
            remainingBudget(),
            (arguments_, remaining, attempt) => this.client(arguments_, remaining, attempt),
            signal,
          );
          stopped = cancellation.cleanup === 'confirmed';
          detail = cancellation.detail;
        }
        // Close only an unchanged shell after the owned process has exited. Never close a reused pane.
        if (stopped && (await shellIsOwned())) {
          await call(['pane', 'close', owned.paneId]);
          detail = 'Owned process stopped and pane closed. Detached descendants are not covered.';
        }
      } catch (error) {
        detail = `${String(error)} Check pane ${owned.paneId} manually. Detached descendants are not covered.`;
      }
    }
    handle.cleanupDetail = reason === 'failure' ? `${detail} ${failureDetail}` : detail;
    record(() => {
      if (reason === 'timeout' || reason === 'cancelled') {
        recordEvent(
          directory,
          task.taskId,
          reason,
          `Parent requested ${reason}. ${detail}`,
          stopped,
        );
      } else if (reason === 'failure' && !readEvent(directory, task.taskId, 'startupFailure')) {
        recordEvent(directory, task.taskId, 'startupFailure', failureDetail);
      }
    });
    record(() => {
      recordEvent(directory, task.taskId, 'cleanup', detail, stopped);
    });
    let outcome: string = reason;
    record(() => {
      outcome = taskStatus(directory, this.ownerId, false).outcome;
    });
    if (!this.closed) {
      record(() => {
        recordEvent(directory, task.taskId, 'notified', 'Parent notification attempted once.');
      });
      const errors = handle.recordErrors.length
        ? ` Evidence errors: ${handle.recordErrors.join('; ')}. Check pane ${handle.paneId ?? 'unknown'} manually.`
        : '';
      this.notify(
        `Worker ${task.name ?? 'unnamed'} (${task.taskId}): ${outcome}. ${handle.cleanupDetail}${errors} Records: ${directory}. Native session: ${task.nativeSessionId} (${task.nativeSessionFile}).`,
      );
    }
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

      return taskStatus(
        directory,
        this.closed || !handle ? undefined : this.ownerId,
        !handle?.stopping,
      );
    } catch (error) {
      // The handle is assigned only after the parent-session check; rejected callers cannot stop work.
      if (handle && !this.closed) {
        void this.stop(
          handle,
          'failure',
          `Worker evidence unavailable: ${String(error)}. No retry.`,
        );
      }
      const native = task
        ? `Native session: ${task.nativeSessionId} (${task.nativeSessionFile}).`
        : 'Native session unavailable; inspect the saved directory.';

      throw new Error(
        `Worker ${taskId}: saved evidence is unavailable: ${String(error)}. ${handle?.cleanupDetail ?? 'Cleanup unconfirmed.'} Check pane ${handle?.paneId ?? 'unknown'} manually. Records: ${directory}. ${native}`,
        { cause: error },
      );
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
    answer: { questionId: string; replyId: string; reply: string; scopeUnchanged: unknown },
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
    const value = {
      version: 1,
      taskId,
      questionId: answer.questionId,
      replyId: answer.replyId,
      reply: answer.reply,
    };

    const saved = readReply(directory, taskId, answer.questionId);
    if (saved) {
      acceptReply(directory, taskId, value);

      return {
        replyAccepted: true,
        workerAcknowledged: !!readAcknowledgement(directory, taskId, answer.questionId),
        delivery: 'Not retried. Prior delivery may be uncertain.',
      };
    }
    if (readPendingQuestion(directory, taskId)?.questionId !== answer.questionId) {
      throw new Error('Reply does not match the pending question.');
    }
    const call = (arguments_: string[]) =>
      this.client(arguments_, workBudget(handle), handle.abort.signal);
    await inspectWorker(handle, call);
    ensureReplyActive(handle);
    // Another caller may have accepted this reply during the identity check. Never send it twice.
    if (readReply(directory, taskId, answer.questionId)) {
      acceptReply(directory, taskId, value);

      return {
        replyAccepted: true,
        workerAcknowledged: !!readAcknowledgement(directory, taskId, answer.questionId),
        delivery: 'Not retried. Prior delivery may be uncertain.',
      };
    }

    acceptReply(directory, taskId, value);
    const reference = {
      version: 1,
      taskId,
      questionId: answer.questionId,
      replyId: answer.replyId,
    };
    try {
      await call([
        'agent',
        'prompt',
        text(handle.paneId),
        `TAU_REPLY ${JSON.stringify(reference)}`,
      ]);
    } catch (error) {
      throw new Error(
        'Reply accepted durably, but delivery is uncertain. Do not retry delivery; inspect acknowledgement.',
        { cause: error },
      );
    }

    return {
      replyAccepted: true,
      workerAcknowledged: !!readAcknowledgement(directory, taskId, answer.questionId),
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

  close(): void {
    this.closed = true;
    this.lifetime.abort();

    for (const handle of this.handles.values()) {
      clearTimeout(handle.timer);
      handle.removeLaunchAbort?.();
      handle.abort.abort();
    }
  }
}
