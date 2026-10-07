import { execFile } from 'node:child_process';

import { hasErrorCode } from '../../errors.js';

export interface OwnedWorker {
  // Pi ownership format 2: the pane's shell process is the worker process.
  readonly version?: 2;
  readonly kind: 'pi';
  readonly paneId: string;
  readonly terminalId: string;
  readonly shellPid: number;
  readonly processId: number;
  // The Pi session path the worker was launched with.
  readonly token: string;
  readonly startedAt: string;
}

interface ClientOptions {
  signal?: AbortSignal | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

// Node timers overflow above a signed 32-bit millisecond count.
const maximumTimerDelay = 2_147_483_647;
const bytesPerMebibyte = 1_048_576;

const validateBudget = (budget: number) => {
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > maximumTimerDelay) {
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
      { env: environment, maxBuffer: bytesPerMebibyte },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        // eslint-disable-next-line seam/helper-before-use -- Child completion and abort cleanup share callbacks.
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
      // eslint-disable-next-line seam/helper-before-use -- stop and abort need each other for listener cleanup.
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

const sameWorkerOwner = (info: Record<string, unknown>, owned: OwnedWorker): boolean =>
  info.pane_id === owned.paneId &&
  info.shell_pid === owned.shellPid &&
  info.foreground_process_group_id === owned.processId;

const foregroundProcessMatches = (value: unknown, owned: OwnedWorker): boolean => {
  const process = objectOrEmpty(value);

  return process.pid === owned.processId;
};

export const matchesWorker = (info: Record<string, unknown>, owned: OwnedWorker): boolean =>
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
