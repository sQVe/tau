import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import { hasErrorCode } from '../../errors/index.js';
import { resolveTerminal, TerminalIdentityError } from './terminal.js';

export interface OwnedWorker {
  // Pi ownership format 2: the pane's shell process is the worker process.
  readonly version?: 2;
  readonly kind: 'process' | 'pi';
  readonly paneId: string;
  readonly terminalId: string;
  readonly shellPid: number;
  readonly processId: number;
  // A unique launch argument, such as the explicitly selected Pi session path.
  readonly token?: string;
  readonly startedAt?: string;
}

interface CleanupResult {
  cleanup: 'confirmed' | 'refused' | 'unconfirmed';
  detail: string;
}

interface ClientOptions {
  signal?: AbortSignal | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

type Client = (argumentsList: string[], budget: number, signal: AbortSignal) => Promise<string>;

type MutableOwnedWorker = Omit<OwnedWorker, 'paneId'> & { paneId: string };

interface CancellationRun {
  owned: MutableOwnedWorker;
  call: (argumentsList: string[]) => Promise<string>;
  signal: AbortSignal;
  expires: number;
  manual: string;
  shutdown: { inputAttempted: boolean };
  timer: ReturnType<typeof setTimeout>;
}

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
  options: ClientOptions = {},
): Promise<string> => {
  const { signal, environment } = options;

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

const objectOrEmpty = (value: unknown): Record<string, unknown> => {
  if (!isObject(value)) {
    return {};
  }

  return value;
};

const processInfo = (response: string) => {
  const parsed: unknown = JSON.parse(response);

  return objectOrEmpty(objectOrEmpty(objectOrEmpty(parsed).result).process_info);
};

const sameWorkerOwner = (info: Record<string, unknown>, owned: OwnedWorker): boolean =>
  info.pane_id === owned.paneId &&
  info.shell_pid === owned.shellPid &&
  info.foreground_process_group_id === owned.processId;

const argvHasLaunchToken = (process: Record<string, unknown>, owned: OwnedWorker): boolean =>
  owned.token !== undefined && Array.isArray(process.argv) && process.argv.includes(owned.token);

const kindUsesStartTime = (owned: OwnedWorker): boolean =>
  owned.kind === 'pi' && Boolean(owned.startedAt);

const processIdentityMatches = (process: Record<string, unknown>, owned: OwnedWorker): boolean =>
  argvHasLaunchToken(process, owned) || kindUsesStartTime(owned);

const foregroundProcessMatches = (value: unknown, owned: OwnedWorker): boolean => {
  const process = objectOrEmpty(value);

  return process.pid === owned.processId && processIdentityMatches(process, owned);
};

export const matchesWorker = (info: Record<string, unknown>, owned: OwnedWorker) =>
  sameWorkerOwner(info, owned) &&
  Array.isArray(info.foreground_processes) &&
  info.foreground_processes.some((value) => foregroundProcessMatches(value, owned));

export const processAbsent = (processId: number): boolean => {
  try {
    process.kill(processId, 0);

    return false;
  } catch (error) {
    return hasErrorCode(error, 'ESRCH');
  }
};

// Cleanup reports EPERM instead of treating it as proof either way.
const processExists = (processId: number) => {
  try {
    process.kill(processId, 0);

    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) {
      return false;
    }

    throw error;
  }
};

const sameStoppedShell = (information: Record<string, unknown>, owned: OwnedWorker): boolean =>
  information.pane_id === owned.paneId &&
  information.shell_pid === owned.shellPid &&
  information.foreground_process_group_id === owned.shellPid;

export const workerStopped = (information: Record<string, unknown>, owned: OwnedWorker): boolean =>
  sameStoppedShell(information, owned) && !processExists(owned.processId);

const isPositiveInteger = (value: number): boolean => Number.isSafeInteger(value) && value > 0;

// A Pi worker is its pane's own process; closing the pane stops it, so it never gets keys.
const hasWorkerIdentity = (owned: OwnedWorker): boolean =>
  owned.kind === 'process' && Boolean(owned.paneId) && Boolean(owned.terminalId);

const hasValidProcessIds = (owned: OwnedWorker): boolean =>
  isPositiveInteger(owned.shellPid) &&
  isPositiveInteger(owned.processId) &&
  owned.shellPid !== owned.processId;

const validateWorker = (owned: OwnedWorker): void => {
  const identityIsComplete = hasWorkerIdentity(owned) && Boolean(owned.token);

  if (!identityIsComplete || !hasValidProcessIds(owned)) {
    throw new Error(
      'Cancellation requires a known owned foreground worker and unique launch argument.',
    );
  }
};

const shutdownKeys = (owned: OwnedWorker): string[] => [
  'pane',
  'send-keys',
  owned.paneId,
  'ctrl+c',
];

const stopConfirmed: CleanupResult = {
  cleanup: 'confirmed',
  detail:
    'The owned process is absent and its shell is foreground; detached or background descendants are not covered.',
};

// Follows the same terminal if it moves while shutdown is pending.
const hasStopped = async (
  worker: Omit<OwnedWorker, 'paneId'> & { paneId: string },
  call: (argumentsList: string[]) => Promise<string>,
) => {
  const location = await resolveTerminal(worker.terminalId, call);

  worker.paneId = location.paneId;
  const after = processInfo(await call(['pane', 'process-info', '--pane', worker.paneId]));

  return workerStopped(after, worker);
};

const waitForStop = async (
  owned: OwnedWorker,
  call: (argumentsList: string[]) => Promise<string>,
  signal: AbortSignal,
): Promise<CleanupResult> => {
  const worker = { ...owned };

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Confirm the foreground job ended within the same cancellation budget.
    if (await hasStopped(worker, call)) {
      return stopConfirmed;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Polling is bounded by the shared cancellation signal.
    await delay(25, undefined, { signal });
  }
};

const refreshTerminal = async (run: CancellationRun): Promise<void> => {
  const location = await resolveTerminal(run.owned.terminalId, run.call);

  run.owned.paneId = location.paneId;
};

const refuseInput = (run: CancellationRun, reason: string): CleanupResult => ({
  cleanup: 'refused',
  detail: `${reason}; no input sent. ${run.manual}`,
});

const agentIdentityMatches = (agent: Record<string, unknown>, owned: OwnedWorker): boolean =>
  agent.pane_id === owned.paneId &&
  agent.agent === owned.kind &&
  objectOrEmpty(agent.agent_session).value === owned.token;

const verifyAgentSession = async (run: CancellationRun): Promise<CleanupResult | undefined> => {
  if (run.owned.kind === 'process') {
    return undefined;
  }

  const response: unknown = JSON.parse(await run.call(['agent', 'get', run.owned.paneId]));
  const agent = objectOrEmpty(objectOrEmpty(objectOrEmpty(response).result).agent);

  if (!agentIdentityMatches(agent, run.owned)) {
    return refuseInput(run, `${run.owned.kind} session identity did not match`);
  }

  return undefined;
};

const verifyProcessStart = async (run: CancellationRun): Promise<CleanupResult | undefined> => {
  if (run.owned.startedAt == null || run.owned.startedAt === '') {
    return undefined;
  }

  const processStart = await runClient(
    'ps',
    ['-p', String(run.owned.processId), '-o', 'lstart='],
    Math.max(1, Math.ceil(run.expires - performance.now())),
    { signal: run.signal },
  );

  const startedAt = processStart.trim();

  if (startedAt !== run.owned.startedAt) {
    return refuseInput(run, 'Process start identity changed');
  }

  return undefined;
};

const verifyWorkerState = async (run: CancellationRun): Promise<CleanupResult | undefined> => {
  const before = processInfo(await run.call(['pane', 'process-info', '--pane', run.owned.paneId]));

  if (!matchesWorker(before, run.owned)) {
    return refuseInput(run, 'Worker identity did not match');
  }

  const checkedPane = run.owned.paneId;

  await refreshTerminal(run);

  if (run.owned.paneId !== checkedPane) {
    throw new TerminalIdentityError('Worker moved during identity checks; no input sent.');
  }

  return undefined;
};

const interruptWorker = async (run: CancellationRun): Promise<CleanupResult | undefined> => {
  await refreshTerminal(run);

  const refusal =
    (await verifyAgentSession(run)) ??
    (await verifyProcessStart(run)) ??
    (await verifyWorkerState(run));

  if (refusal) {
    return refusal;
  }

  run.shutdown.inputAttempted = true;
  await run.call(shutdownKeys(run.owned));

  return undefined;
};

const createCancellationRun = (
  owned: MutableOwnedWorker,
  budget: number,
  client: Client,
  parent: AbortSignal,
): CancellationRun => {
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

  const manual = `Check terminal ${owned.terminalId} (last pane ${owned.paneId}) and worker ${owned.processId} (${owned.token ?? 'no launch token'}) for manual cleanup.`;

  return { owned, call, signal, expires, manual, shutdown: { inputAttempted: false }, timer };
};

const failedCleanup = (error: unknown, run: CancellationRun): CleanupResult => {
  const cleanup =
    !run.shutdown.inputAttempted && error instanceof TerminalIdentityError
      ? 'refused'
      : 'unconfirmed';

  return { cleanup, detail: `${String(error)} ${run.manual}` };
};

// Requires herdr and the worker on this machine because process identity checks use local ps.
// Terminal input is identity-checked, not containment or atomic compare-and-stop.
export const cancelOwnedWorker = async (
  worker: OwnedWorker,
  budget: number,
  client: Client,
  parent: AbortSignal,
): Promise<CleanupResult> => {
  validateBudget(budget);
  const owned = { ...worker };

  validateWorker(owned);

  const run = createCancellationRun(owned, budget, client, parent);
  // The worker can exit on its own during checks or input, which fails them.
  const stoppedAnyway = () => hasStopped({ ...owned }, run.call).catch(() => false);

  try {
    const refused = await interruptWorker(run);

    if (refused) {
      return (await stoppedAnyway()) ? stopConfirmed : refused;
    }

    return await waitForStop(owned, run.call, run.signal);
  } catch (error) {
    if (await stoppedAnyway()) {
      return stopConfirmed;
    }

    return failedCleanup(error, run);
  } finally {
    clearTimeout(run.timer);
  }
};
