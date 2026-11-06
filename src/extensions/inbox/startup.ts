import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface StartupGate {
  // Rejects when the signal aborts or the session generation ends, so a waiter from an earlier
  // generation never resolves into its replacement.
  whenReady: (signal: AbortSignal) => Promise<void>;
  isReady: () => boolean;
}

interface Waiter {
  resolve: () => void;
  reject: (reason: Error) => void;
}

const generationEnded = (): Error => new Error('The session generation ended before startup.');

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('The startup wait was aborted.');

// Pi 1.5.0 has no session-ready event. `bindExtensions` awaits every `session_start` handler and
// then emits `resources_discover`; interactive mode calls `subscribeToAgent()` after that. Opening
// on the next macrotask lets that caller install the terminal-status subscription first. Another
// extension's slow `resources_discover` handler can still let the first woken run start before Pi
// reports its status, so the status shows idle until that run settles.
export const createStartupGate = (pi: ExtensionAPI): StartupGate => {
  let active = false;
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiters = new Set<Waiter>();

  const endGeneration = (): void => {
    open = false;

    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    const ended = waiters;

    waiters = new Set();

    for (const waiter of ended) {
      waiter.reject(generationEnded());
    }
  };

  const scheduleOpen = (): void => {
    if (!active || timer !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      open = true;

      const ready = waiters;

      waiters = new Set();

      for (const waiter of ready) {
        waiter.resolve();
      }
    }, 0);
  };

  pi.on('session_start', () => {
    active = true;
    endGeneration();
  });

  pi.on('resources_discover', () => {
    scheduleOpen();
  });

  pi.on('session_shutdown', () => {
    active = false;
    endGeneration();
  });

  const whenReady = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) {
      return Promise.reject(abortReason(signal));
    }

    if (open) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        waiters.delete(waiter);
        reject(abortReason(signal));
      };

      const waiter: Waiter = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: (reason) => {
          signal.removeEventListener('abort', onAbort);
          reject(reason);
        },
      };

      waiters.add(waiter);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  return { whenReady, isReady: () => open };
};
