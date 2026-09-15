import { execFile } from 'node:child_process';

export interface OwnedWorker {
  readonly kind: 'process' | 'pi';
  readonly paneId: string;
  readonly shellPid: number;
  readonly processId: number;
  // A unique launch argument, such as the explicitly selected Pi session path.
  readonly token: string;
}

interface CleanupResult {
  cleanup: 'confirmed' | 'refused' | 'unconfirmed';
  detail: string;
}

interface DeadlineResult extends CleanupResult {
  reason: 'timeout' | 'parent-stopped';
  output: 'incomplete';
}

type Client = (arguments_: string[], budget: number, signal: AbortSignal) => Promise<string>;

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Parent or cancellation budget ended.'));
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });

const validateBudget = (budget: number) => {
  if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 2_147_483_647) {
    throw new Error('The budget must be a positive timer-safe integer in milliseconds.');
  }
};

// Bound the wait as well as the child. Do not wait for inherited pipes after a client failure.
export const runClient = (
  executable: string,
  arguments_: string[],
  budget: number,
  signal?: AbortSignal,
  environment?: NodeJS.ProcessEnv,
): Promise<string> => {
  validateBudget(budget);

  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = execFile(
      executable,
      arguments_,
      { env: environment, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);

        if (error) {
          reject(new Error(error.message));
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

const matchesWorker = (info: Record<string, unknown>, owned: OwnedWorker) =>
  info.pane_id === owned.paneId &&
  info.shell_pid === owned.shellPid &&
  info.foreground_process_group_id === owned.processId &&
  Array.isArray(info.foreground_processes) &&
  info.foreground_processes.some((value: unknown) => {
    const process = object(value);

    return (
      process.pid === owned.processId &&
      Array.isArray(process.argv) &&
      process.argv.includes(owned.token)
    );
  });

const processExists = (processId: number) => {
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

const validateWorker = (owned: OwnedWorker) => {
  if (
    !['process', 'pi'].includes(owned.kind) ||
    !owned.paneId ||
    !owned.token ||
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
  const call = (arguments_: string[]) => {
    signal.throwIfAborted();
    const remaining = Math.ceil(expires - performance.now());
    validateBudget(remaining);

    return client(arguments_, remaining, signal);
  };
  const manual = `Check ${owned.paneId} and worker ${owned.processId} (${owned.token}) for manual cleanup.`;

  try {
    if (owned.kind === 'pi') {
      const response: unknown = JSON.parse(await call(['agent', 'get', owned.paneId]));
      const agent = object(object(object(response).result).agent);
      if (
        agent.pane_id !== owned.paneId ||
        agent.agent !== 'pi' ||
        object(agent.agent_session).value !== owned.token
      ) {
        return {
          cleanup: 'refused',
          detail: `Pi session identity did not match; no input sent. ${manual}`,
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

    // Pi's Ctrl+C clears the editor. Ctrl+D then requests shutdown from the empty editor.
    const keys =
      owned.kind === 'pi'
        ? ['agent', 'send-keys', owned.paneId, 'ctrl+c', 'ctrl+d']
        : ['pane', 'send-keys', owned.paneId, 'ctrl+c'];
    await call(keys);

    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Confirm the foreground job ended within the same cancellation budget.
      const after = processInfo(await call(['pane', 'process-info', '--pane', owned.paneId]));
      if (
        after.pane_id === owned.paneId &&
        after.shell_pid === owned.shellPid &&
        after.foreground_process_group_id === owned.shellPid &&
        !processExists(owned.processId)
      ) {
        return {
          cleanup: 'confirmed',
          detail:
            'The owned process is absent and its shell is foreground; detached or background descendants are not covered.',
        };
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- Polling is bounded by the shared cancellation signal.
      await delay(25, signal);
    }
  } catch (error) {
    return { cleanup: 'unconfirmed', detail: `${String(error)} ${manual}` };
  } finally {
    clearTimeout(timer);
  }
};

// Keep this handle in the active parent. Reconnect observes it; it never launches or resubmits work.
export const createParentDeadline = (
  worker: OwnedWorker,
  timeout: number,
  cancellationBudget: number,
  client: Client,
  parent: AbortSignal,
) => {
  validateBudget(timeout);
  validateBudget(cancellationBudget);
  const owned = { ...worker };
  validateWorker(owned);
  if (cancellationBudget >= timeout) {
    throw new Error('Reserve a cancellation budget smaller than the total task timeout.');
  }

  const deadline = performance.now() + timeout;
  const result: Promise<DeadlineResult> = (async () => {
    try {
      await delay(timeout - cancellationBudget, parent);
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) {
        throw new Error('The fixed deadline expired before cancellation could start.');
      }

      const cleanup = await cancelOwnedWorker(owned, remaining, client, parent);

      return {
        ...cleanup,
        reason: parent.aborted ? 'parent-stopped' : 'timeout',
        output: 'incomplete',
      };
    } catch (error) {
      return {
        reason: parent.aborted ? 'parent-stopped' : 'timeout',
        output: 'incomplete',
        cleanup: 'unconfirmed',
        detail: `${String(error)} No continuing enforcement is promised. Check ${owned.paneId} for manual cleanup.`,
      };
    }
  })();

  return { deadline, watch: () => result };
};
