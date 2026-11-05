import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface StartupGate {
  whenReady: () => Promise<void>;
  isReady: () => boolean;
}

// Pi 1.5.0 has no session-ready event. `bindExtensions` awaits every `session_start` handler and
// then emits `resources_discover`; interactive mode calls `subscribeToAgent()` after that. Opening
// on the next macrotask lets that caller install the terminal-status subscription first. Another
// extension's slow `resources_discover` handler can still let the first woken run start before Pi
// reports its status, so the status shows idle until that run settles.
export const createStartupGate = (pi: ExtensionAPI): StartupGate => {
  let active = false;
  let open = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiters: (() => void)[] = [];

  const close = (): void => {
    open = false;

    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const scheduleOpen = (): void => {
    if (!active || timer !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      open = true;

      const pending = waiters;

      waiters = [];

      for (const resolve of pending) {
        resolve();
      }
    }, 0);
  };

  pi.on('session_start', () => {
    active = true;
    close();
  });

  pi.on('resources_discover', () => {
    scheduleOpen();
  });

  pi.on('session_shutdown', () => {
    active = false;
    close();
  });

  return {
    whenReady: () => {
      if (open) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },
    isReady: () => open,
  };
};
