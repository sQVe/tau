import type { SubscribeEvents } from '../hc/events.js';
import type { HcRuntime } from '../hc/hc.js';
import type { Wake } from '../wake/wake.js';
import type { InboxScanContext, StartupGate } from './receive.js';
import { createInboxSession } from './session.js';
import type { InboxSession } from './session.js';

interface InboxStartContext {
  sessionId: string;
  context: InboxScanContext;
}

export interface InboxWatchOptions {
  hc: HcRuntime;
  subscribe: SubscribeEvents;
  terminal: () => string | undefined;
  gate: StartupGate;
  wake: Wake;
  notify: (context: InboxScanContext, message: string, key: string) => void;
}

export interface InboxWatch {
  start: (start: InboxStartContext) => Promise<void>;
  stop: () => Promise<void>;
  requestScan: () => void;
}

export const createInboxWatch = (options: InboxWatchOptions): InboxWatch => {
  let generation = 0;
  let active: InboxSession | undefined;
  let draining: Promise<void> = Promise.resolve();

  // Every earlier session finishes its lease cleanup before a replacement writes its own lease.
  const stop = (): Promise<void> => {
    generation += 1;

    const previous = active;

    active = undefined;

    if (previous !== undefined) {
      const earlier = draining;
      const cleanup = previous.stop();

      draining = Promise.all([earlier, cleanup]).then(() => undefined);
    }

    return draining;
  };

  const start = async (startContext: InboxStartContext): Promise<void> => {
    const previous = stop();
    const current = generation;
    const terminal = options.terminal();

    await previous;

    if (terminal === undefined || current !== generation) {
      return;
    }

    active = createInboxSession({ ...options, terminal, ...startContext });
    active.start();
  };

  return {
    start,
    stop,
    requestScan: () => {
      active?.requestScan();
    },
  };
};
