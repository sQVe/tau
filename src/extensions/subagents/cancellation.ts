import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { resolveTerminal, TerminalIdentityError } from './terminal.js';

export interface OwnedWorker {
  readonly kind: 'process' | 'pi' | 'generic';
  readonly paneId: string;
  readonly terminalId: string;
  readonly shellPid: number;
  readonly processId: number;
  // A unique launch argument, such as the explicitly selected Pi session path.
  readonly token?: string;
  readonly startedAt?: string;
  readonly agentKind?: string;
  readonly shellStartedAt?: string;
  readonly nativeReference?: { kind: string; value: string };
}

interface CleanupResult {
  cleanup: 'confirmed' | 'refused' | 'unconfirmed';
  detail: string;
}

type Client = (argumentsList: string[], budget: number, signal: AbortSignal) => Promise<string>;

const validateBudget = (budget: number) => {
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647) {
    throw new Error('The budget must be a positive timer-safe integer in milliseconds.');
  }
};

// Bound the wait as well as the child. Do not wait for inherited pipes after a client failure.
export const runClient = (
  executable: string,
  argumentsList: string[],
  budget: number,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<string> => {
  validateBudget(budget);

  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = execFile(
      executable,
      argumentsList,
      { env: environment, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        // eslint-disable-next-line tau/helper-before-use -- Child completion and abort cleanup share callbacks.
        signal?.removeEventListener('abort', abort);

        if (error) {
          const failure = new Error(error.message, { cause: error });
          Object.assign(failure, { stderr });
          reject(failure);
        } else {
          resolve(stdout);
        }
      },
    );
    const stop = (error: Error) => {
      reject(error);
      child.kill('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      clearTimeout(timer);
      // eslint-disable-next-line tau/helper-before-use -- stop and abort need each other for listener cleanup.
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      stop(new Error('Client call cancelled; delivery and cleanup are unconfirmed.'));
    };
    const timer = setTimeout(() => {
      stop(new Error('Client attempt budget expired; delivery and cleanup are unconfirmed.'));
    }, budget);
    signal?.addEventListener('abort', abort, { once: true });
  });
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const object = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) {
    return {};
  }

  return value;
};

const processInfo = (response: string) => {
  const parsed: unknown = JSON.parse(response);

  return object(object(object(parsed).result).process_info);
};

export const matchesWorker = (info: Record<string, unknown>, owned: OwnedWorker) =>
  info.pane_id === owned.paneId &&
  info.shell_pid === owned.shellPid &&
  info.foreground_process_group_id === owned.processId &&
  Array.isArray(info.foreground_processes) &&
  info.foreground_processes.some((value: unknown) => {
    const process = object(value);

    return (
      process.pid === owned.processId &&
      // Pi rewrites argv through process.title, and herdr can omit argv entirely. The caller also checks its herdr session token and ps start time before using this fallback.
      ((owned.token !== undefined &&
        Array.isArray(process.argv) &&
        process.argv.includes(owned.token)) ||
        (['pi', 'generic'].includes(owned.kind) && Boolean(owned.startedAt)))
    );
  });

export const processExists = (processId: number) => {
  try {
    process.kill(processId, 0);

    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }

    throw error;
  }
};

export const workerStopped = (information: Record<string, unknown>, owned: OwnedWorker): boolean =>
  information.pane_id === owned.paneId &&
  information.shell_pid === owned.shellPid &&
  information.foreground_process_group_id === owned.shellPid &&
  !processExists(owned.processId);

const validateWorker = (owned: OwnedWorker) => {
  if (
    !['process', 'pi', 'generic'].includes(owned.kind) ||
    !owned.paneId ||
    !owned.terminalId ||
    (owned.kind === 'generic'
      ? !owned.agentKind || !owned.startedAt || !owned.shellStartedAt
      : !owned.token) ||
    !Number.isSafeInteger(owned.shellPid) ||
    !Number.isSafeInteger(owned.processId) ||
    owned.shellPid <= 0 ||
    owned.processId <= 0 ||
    owned.shellPid === owned.processId
  ) {
    throw new Error(
      'Cancellation requires a known owned foreground worker and unique launch argument.',
    );
  }
};

// Escape requests active-run abort; shutdown keys remain best-effort while tools unwind.
const shutdownKeys = (owned: OwnedWorker): string[] =>
  owned.kind === 'pi'
    ? ['agent', 'send-keys', owned.paneId, 'escape', 'ctrl+c', 'ctrl+d']
    : [owned.kind === 'generic' ? 'agent' : 'pane', 'send-keys', owned.paneId, 'ctrl+c'];

const stopConfirmed: CleanupResult = {
  cleanup: 'confirmed',
  detail:
    'The owned process is absent and its shell is foreground; detached or background descendants are not covered.',
};

// Follows the same terminal if it moves while shutdown is pending.
const hasStopped = async (
  worker: Omit<OwnedWorker, 'paneId'> & { paneId: string },
  call: (argumentsList: string[]) => Promise<string>,
  signal: AbortSignal,
) => {
  const location = await resolveTerminal(worker.terminalId, call);
  worker.paneId = location.paneId;
  const after = processInfo(await call(['pane', 'process-info', '--pane', worker.paneId]));

  if (!workerStopped(after, worker)) {
    return false;
  }

  if (worker.kind === 'generic') {
    const shellStart = await runClient(
      'ps',
      ['-p', String(worker.shellPid), '-o', 'lstart='],
      1000,
      signal,
    );

    return shellStart.trim() === worker.shellStartedAt;
  }

  return true;
};

const waitForStop = async (
  owned: OwnedWorker,
  call: (argumentsList: string[]) => Promise<string>,
  signal: AbortSignal,
  interrupt: () => Promise<CleanupResult | undefined>,
): Promise<CleanupResult> => {
  const worker = { ...owned };
  let pressedAt = performance.now();
  const stopped = () => hasStopped(worker, call, signal);

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Confirm the foreground job ended within the same cancellation budget.
    if (await stopped()) {
      return stopConfirmed;
    }

    if (worker.kind === 'generic' && performance.now() - pressedAt >= 500) {
      pressedAt = performance.now();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each interrupt repeats ownership checks within the original budget.
      const refused = await interrupt();

      if (refused) {
        // A native agent may end its session before its process exits, so a refusal here can trail a clean stop.
        // oxlint-disable-next-line eslint/no-await-in-loop -- One confirmation attempt within the remaining budget.
        if (await stopped()) {
          return stopConfirmed;
        }

        return {
          cleanup: 'unconfirmed',
          detail: `Further interrupt refused after an earlier attempt. ${refused.detail}`,
        };
      }
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling is bounded by the shared cancellation signal.
    await delay(25, undefined, { signal });
  }
};

// Local herdr only. This is identity-checked terminal input, not containment or atomic compare-and-stop.
export const cancelOwnedWorker = async (
  worker: OwnedWorker,
  budget: number,
  client: Client,
  parent: AbortSignal,
): Promise<CleanupResult> => {
  validateBudget(budget);
  const owned = { ...worker };
  validateWorker(owned);

  const expires = performance.now() + budget;
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => {
    controller.abort();
  }, budget);
  const call = (argumentsList: string[]) => {
    signal.throwIfAborted();
    const remaining = Math.ceil(expires - performance.now());
    validateBudget(remaining);

    return client(argumentsList, remaining, signal);
  };
  const manual = `Check terminal ${owned.terminalId} (last pane ${owned.paneId}) and worker ${owned.processId} (${owned.token ?? owned.agentKind}) for manual cleanup.`;
  const refresh = async () => {
    const location = await resolveTerminal(owned.terminalId, call);

    owned.paneId = location.paneId;
  };
  const shutdown = { inputAttempted: false };

  const interrupt = async (): Promise<CleanupResult | undefined> => {
    await refresh();

    if (owned.kind !== 'process') {
      const response: unknown = JSON.parse(await call(['agent', 'get', owned.paneId]));
      const agent = object(object(object(response).result).agent);

      if (
        agent.pane_id !== owned.paneId ||
        agent.agent !== (owned.kind === 'generic' ? owned.agentKind : owned.kind) ||
        (owned.kind === 'generic'
          ? owned.nativeReference !== undefined &&
            (object(agent.agent_session).value !== owned.nativeReference.value ||
              object(agent.agent_session).kind !== owned.nativeReference.kind)
          : object(agent.agent_session).value !== owned.token)
      ) {
        return {
          cleanup: 'refused',
          detail: `${owned.kind} session identity did not match; no input sent. ${manual}`,
        };
      }
    }

    if (owned.startedAt) {
      const processStart = await runClient(
        'ps',
        ['-p', String(owned.processId), '-o', 'lstart='],
        Math.max(1, Math.ceil(expires - performance.now())),
        signal,
      );
      const startedAt = processStart.trim();

      if (startedAt !== owned.startedAt) {
        return {
          cleanup: 'refused',
          detail: `Process start identity changed; no input sent. ${manual}`,
        };
      }
    }

    if (owned.kind === 'generic') {
      const shellStart = await runClient(
        'ps',
        ['-p', String(owned.shellPid), '-o', 'lstart='],
        Math.max(1, Math.ceil(expires - performance.now())),
        signal,
      );

      if (shellStart.trim() !== owned.shellStartedAt) {
        return {
          cleanup: 'refused',
          detail: `Shell start identity changed; no input sent. ${manual}`,
        };
      }
    }

    const before = processInfo(await call(['pane', 'process-info', '--pane', owned.paneId]));

    if (!matchesWorker(before, owned)) {
      return {
        cleanup: 'refused',
        detail: `Worker identity did not match; no input sent. ${manual}`,
      };
    }

    const checkedPane = owned.paneId;
    await refresh();

    if (owned.paneId !== checkedPane) {
      throw new TerminalIdentityError('Worker moved during identity checks; no input sent.');
    }

    shutdown.inputAttempted = true;
    await call(shutdownKeys(owned));

    return undefined;
  };

  // The worker can exit on its own during checks or input, which fails them.
  const stoppedAnyway = () => hasStopped({ ...owned }, call, signal).catch(() => false);

  try {
    const refused = await interrupt();

    if (refused) {
      return (await stoppedAnyway()) ? stopConfirmed : refused;
    }

    return await waitForStop(owned, call, signal, interrupt);
  } catch (error) {
    if (await stoppedAnyway()) {
      return stopConfirmed;
    }

    return {
      cleanup:
        !shutdown.inputAttempted && error instanceof TerminalIdentityError
          ? 'refused'
          : 'unconfirmed',
      detail: `${String(error)} ${manual}`,
    };
  } finally {
    clearTimeout(timer);
  }
};
