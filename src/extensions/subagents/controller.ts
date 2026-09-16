import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { cancelOwnedWorker, runClient } from './cancellation.js';
import type { OwnedWorker } from './cancellation.js';
import { nativeIdentity, seedSession } from './profiles.js';
import { publish, readEvent, readReport, readTask, recordEvent, validateTask } from './records.js';
import type { Loadout, Report, Task, TaskEvent } from './types.js';

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

export const taskStatus = (directory: string, activeOwner?: string) => {
  const task = readTask(directory);
  const report = readReport(directory, task.taskId);
  const event = (kind: TaskEvent['kind']) => readEvent(directory, task.taskId, kind);
  const timeout = event('timeout');
  const cancelled = event('cancelled');
  const failure = event('startupFailure');
  const settled = event('settled');
  const cleanup = event('cleanup');
  const active = activeOwner === task.ownerId && !cleanup && !timeout && !cancelled;
  const outcome = taskOutcome([timeout, cancelled, failure], report, Boolean(settled) || !active);

  return {
    taskId: task.taskId,
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
}

const waitForWorkerReadiness = async (handle: Handle): Promise<TaskEvent> => {
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
    if (performance.now() >= handle.expires - handle.task.cancellationBudget) {
      throw new Error('Worker readiness exceeded the original startup budget.');
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Readiness remains inside the original deadline and cancellation signal.
    await delay(25, undefined, { signal: handle.abort.signal });
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

export class WorkerController {
  readonly ownerId = randomUUID();
  private readonly handles = new Map<string, Handle>();
  private closed = false;

  constructor(
    private readonly root: string,
    private readonly client: HerdrClient = herdrClient,
    private readonly notify: (message: string) => void = () => undefined,
  ) {}

  async launch(
    input: {
      task: string;
      loadout: Loadout;
      timeout: number;
      parentSession: string;
      parentSessionId: string;
      parentPane: string;
      startedAt?: { wall: number; monotonic: number };
    },
    launchSignal: AbortSignal = new AbortController().signal,
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
      taskId,
      task: input.task,
      parentSession: input.parentSession,
      parentSessionId: input.parentSessionId,
      ownerId: this.ownerId,
      ...nativeIdentity(directory),
      createdAt,
      deadline,
      cancellationBudget,
      loadout: input.loadout,
    });
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    publish(directory, 'task.json', task);
    seedSession(task);
    const handle: Handle = {
      directory,
      task,
      abort: new AbortController(),
      expires,
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
      const call = (arguments_: string[]) =>
        this.client(
          arguments_,
          Math.max(
            1,
            Math.floor(
              Math.min(30_000, handle.expires - task.cancellationBudget - performance.now()),
            ),
          ),
          handle.abort.signal,
        );
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
      await call([
        'agent',
        'start',
        `tau-${taskId.replaceAll('-', '').slice(0, 24)}`,
        '--kind',
        'pi',
        '--pane',
        handle.paneId,
        '--timeout',
        String(
          Math.max(
            1,
            Math.floor(
              Math.min(30_000, handle.expires - task.cancellationBudget - performance.now()),
            ),
          ),
        ),
        '--',
        ...workerArguments(task),
      ]);
      const ready = await waitForWorkerReadiness(handle);
      const information = object(
        result(await call(['pane', 'process-info', '--pane', handle.paneId])).process_info,
      );
      const agent = object(result(await call(['agent', 'get', handle.paneId])).agent);
      if (
        agent.pane_id !== handle.paneId ||
        agent.agent !== 'pi' ||
        object(agent.agent_session).value !== task.nativeSessionFile ||
        ready.processId !== information.foreground_process_group_id
      ) {
        throw new Error('Native session and worker readiness identities did not match.');
      }
      const processStart = await runClient(
        'ps',
        ['-p', String(ready.processId), '-o', 'lstart='],
        1000,
        handle.abort.signal,
      );
      const startedAt = processStart.trim();
      if (!startedAt) {
        throw new Error('Worker process start identity is unavailable.');
      }
      const owned: OwnedWorker = {
        kind: 'pi',
        paneId: handle.paneId,
        shellPid: integer(information.shell_pid),
        processId: integer(information.foreground_process_group_id),
        token: task.nativeSessionFile,
        startedAt,
      };
      if (
        information.pane_id !== owned.paneId ||
        owned.shellPid === owned.processId ||
        !Array.isArray(information.foreground_processes) ||
        !information.foreground_processes.some((entry) => {
          const process = object(entry);
          return process.pid === owned.processId;
        })
      ) {
        throw new Error('Started worker identity could not be established.');
      }
      handle.owned = owned;
      publish(directory, 'owned.json', owned);
      handle.abort.signal.throwIfAborted();
      publish(directory, 'dispatch.json', { taskId });
      this.poll(handle);
      handle.removeLaunchAbort();
    } catch (error) {
      if (!readEvent(directory, taskId, 'startupFailure')) {
        recordEvent(
          directory,
          taskId,
          'startupFailure',
          `Startup delivery is uncertain; no retry. ${String(error)}`,
        );
      }
      await this.stop(handle, 'failure');
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
            readEvent(handle.directory, handle.task.taskId, 'startupFailure')
          ) {
            void this.stop(handle, 'completion');
            return;
          }
          this.poll(handle);
        } catch (error) {
          this.notify(
            `Worker ${handle.task.taskId}: ${String(error)}. Records retained; manual cleanup may be needed.`,
          );
          void this.stop(handle, 'failure');
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
  ): Promise<void> {
    if (handle.stopping) {
      return handle.stopping;
    }
    if (handle.timer) {
      clearTimeout(handle.timer);
    }
    handle.removeLaunchAbort?.();
    handle.abort.abort();
    handle.stopping = this.cleanup(handle, reason).catch((error: unknown) => {
      this.notify(
        `Worker ${handle.task.taskId}: cleanup unconfirmed. ${String(error)}. Check pane ${handle.paneId ?? 'unknown'} manually.`,
      );
    });

    return handle.stopping;
  }

  private async cleanup(
    handle: Handle,
    reason: 'timeout' | 'cancelled' | 'completion' | 'failure',
  ): Promise<void> {
    const { directory, task, owned } = handle;
    if (reason === 'timeout' || reason === 'cancelled') {
      recordEvent(
        directory,
        task.taskId,
        reason,
        `Parent requested ${reason}; stopping is not yet confirmed.`,
      );
    }
    const budget = Math.max(
      1,
      Math.floor(Math.min(task.cancellationBudget, handle.expires - performance.now())),
    );
    const signal = AbortSignal.timeout(budget);
    let stopped = false;
    let detail = `Cleanup unconfirmed. Check pane ${handle.paneId ?? 'unknown'} manually. No automatic retry.`;

    if (owned) {
      const shellIsOwned = async () => {
        const information = object(
          result(
            await this.client(['pane', 'process-info', '--pane', owned.paneId], budget, signal),
          ).process_info,
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
        if (!stopped) {
          const cancellation = await cancelOwnedWorker(
            owned,
            budget,
            (arguments_, remaining, attempt) => this.client(arguments_, remaining, attempt),
            signal,
          );
          stopped = cancellation.cleanup === 'confirmed';
          detail = cancellation.detail;
        }
        // Close only an unchanged shell after the owned process has exited. Never close a reused pane.
        if (stopped && (await shellIsOwned())) {
          await this.client(['pane', 'close', owned.paneId], budget, signal);
          detail = 'Owned process stopped and pane closed. Detached descendants are not covered.';
        }
      } catch (error) {
        detail = `${String(error)} Check pane ${owned.paneId} manually. Detached descendants are not covered.`;
      }
    }
    recordEvent(directory, task.taskId, 'cleanup', detail, stopped);
    if (!readEvent(directory, task.taskId, 'notified')) {
      recordEvent(directory, task.taskId, 'notified', 'Parent notification attempted once.');
      this.notify(
        `Worker ${task.taskId}: ${taskStatus(directory, this.ownerId).outcome}. ${detail} Records: ${directory}`,
      );
    }
  }

  status(taskId: string, parentSessionId: string) {
    const directory = this.directory(taskId, parentSessionId);

    return taskStatus(
      directory,
      this.closed || !this.handles.has(taskId) ? undefined : this.ownerId,
    );
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
    if (readTask(directory).parentSessionId !== parentSessionId) {
      throw new Error('Task belongs to another parent session.');
    }

    return directory;
  }

  close(): void {
    this.closed = true;
    for (const handle of this.handles.values()) {
      clearTimeout(handle.timer);
      handle.removeLaunchAbort?.();
      handle.abort.abort();
    }
  }
}
