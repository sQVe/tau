import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface StartupGate {
  whenReady: (signal: AbortSignal) => Promise<void>;
  isReady: () => boolean;
}

const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error('The startup wait was aborted.');

// Pi 1.5.0 has no session-ready event. `bindExtensions` awaits every `session_start` handler and
// then emits `resources_discover`; interactive mode calls `subscribeToAgent()` after that. Opening
// on the next macrotask lets that caller install the terminal-status subscription first. Another
// extension's slow `resources_discover` handler can still let the first woken run start before Pi
// reports its status, so the status shows idle until that run settles.
export const createStartupGate = (pi: ExtensionAPI): StartupGate => {
  let active = false;
  let opened = Promise.withResolvers<undefined>();
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const reset = (): void => {
    clearTimeout(timer);
    timer = undefined;
    open = false;
    opened = Promise.withResolvers();
  };

  pi.on('session_start', () => {
    active = true;
    reset();
  });

  pi.on('resources_discover', () => {
    if (!active || timer !== undefined) {
      return;
    }

    const { resolve } = opened;

    timer = setTimeout(() => {
      timer = undefined;
      open = true;
      resolve(undefined);
    }, 0);
  });

  pi.on('session_shutdown', () => {
    active = false;
    reset();
  });

  const whenReady = async (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();

    const aborted = Promise.withResolvers<undefined>();

    const onAbort = (): void => {
      aborted.reject(abortReason(signal));
    };

    signal.addEventListener('abort', onAbort, { once: true });

    try {
      await Promise.race([opened.promise, aborted.promise]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };

  return { whenReady, isReady: () => open };
};
