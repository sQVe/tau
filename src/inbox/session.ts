import type { EventSelector, SubscribeEvents } from '../hc/events.js';
import { createEventWatch } from '../hc/eventWatch.js';
import { get, label } from '../hc/hc.js';
import type { HcRuntime } from '../hc/hc.js';
import type { Wake } from '../wake/wake.js';
import { decideInboxEventScan } from './eventDecision.js';
import { judgeLeaseOwnership } from './leaseDecision.js';
import { createReceiptStore } from './receipts.js';
import { createReceiver } from './receive.js';
import type { InboxScanContext, StartupGate } from './receive.js';

export interface InboxSessionOptions {
  hc: HcRuntime;
  subscribe: SubscribeEvents;
  terminal: string;
  sessionId: string;
  context: InboxScanContext;
  gate: StartupGate;
  wake: Wake;
  notify: (context: InboxScanContext, message: string, key: string) => void;
}

export interface InboxSession {
  start: () => void;
  stop: () => Promise<void>;
  requestScan: () => void;
}

type LeaseState = 'none' | 'held' | 'lost';

export const leaseLifetimeMilliseconds = 60_000;
export const leaseRenewalMilliseconds = 20_000;
export const leaseCleanupMilliseconds = 5_000;

const leaseLabel = 'tau.inbox';

export const createInboxSession = (options: InboxSessionOptions): InboxSession => {
  const cancel = new AbortController();
  const hc: HcRuntime = { ...options.hc, signal: cancel.signal };
  let stopped = false;
  let ready = false;
  let lease: LeaseState = 'none';
  let written: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let leaseWork: Promise<void> = Promise.resolve();
  let stopping: Promise<void> | undefined;

  const isCurrent = (): boolean => ready && !stopped;

  const clearTimer = (): void => {
    clearInterval(timer);
    timer = undefined;
  };

  const readLease = async (): Promise<string | undefined> => {
    const current = await get(hc, options.terminal);

    return current.labels?.[leaseLabel];
  };

  const observe = (observed: string | undefined): void => {
    if (lease !== 'held') {
      return;
    }

    const ownership = judgeLeaseOwnership({
      observed,
      sessionId: options.sessionId,
      now: Date.now(),
    });

    if (ownership === 'other-live') {
      lease = 'lost';
      clearTimer();
    }
  };

  const refreshLease = async (): Promise<void> => {
    if (!isCurrent()) {
      return;
    }

    if (written !== undefined) {
      const observed = await readLease();

      if (!isCurrent()) {
        return;
      }

      observe(observed);

      if (lease === 'lost') {
        return;
      }
    }

    const attempt = `${options.sessionId}:${Date.now() + leaseLifetimeMilliseconds}`;

    await label(hc, options.terminal, { [leaseLabel]: attempt });
    written = attempt;

    if (lease === 'none') {
      lease = 'held';
    }
  };

  const runLeaseStep = (): Promise<void> => {
    const previous = leaseWork;

    leaseWork = (async () => {
      await previous;

      try {
        await refreshLease();
      } catch {
        // A failed write is retried on the next tick while the subscription stays ready.
      }
    })();

    return leaseWork;
  };

  const isHeld = (): boolean => lease === 'held';

  const renewOrRetry = async (): Promise<void> => {
    const wasHeld = isHeld();

    await runLeaseStep();

    if (!wasHeld && isHeld()) {
      eventWatch.requestScan();
    }
  };

  const confirmOwnership = async (): Promise<boolean> => {
    try {
      observe(await readLease());
    } catch {
      return false;
    }

    return isHeld();
  };

  const receiver = createReceiver({
    hc,
    terminal: options.terminal,
    sessionId: options.sessionId,
    gate: options.gate,
    wake: options.wake,
    notify: options.notify,
    receipts: createReceiptStore(options.sessionId),
    fence: { observe, isCurrent, confirmOwnership },
  });

  const eventWatch = createEventWatch({
    subscribe: options.subscribe,
    selector: (): EventSelector => ({ terminal: options.terminal }),
    scan: async () => {
      if (!isCurrent()) {
        return;
      }

      await leaseWork;
      await receiver.scan(options.context);
    },
    isRelevant: (event) => decideInboxEventScan(event) === 'scan',
    onReady: () => {
      ready = true;

      if (lease === 'lost') {
        return;
      }

      timer = setInterval(() => {
        renewOrRetry().catch(() => undefined);
      }, leaseRenewalMilliseconds);

      runLeaseStep().catch(() => undefined);
    },
    onClose: () => {
      ready = false;
      clearTimer();
    },
    notify: (message, key) => {
      options.notify(options.context, message, key);
    },
  });

  const removeOwnLease = async (): Promise<void> => {
    const value = written;

    if (value === undefined) {
      return;
    }

    const observed = await readLease();

    if (observed === value) {
      await label(hc, options.terminal, { [leaseLabel]: '' });
    }
  };

  const cleanUp = async (): Promise<void> => {
    const deadline = setTimeout(() => {
      cancel.abort();
    }, leaseCleanupMilliseconds);

    try {
      await leaseWork;
      await removeOwnLease();
    } catch {
      // A lease that stays behind expires on its own within the lease lifetime.
    } finally {
      clearTimeout(deadline);
    }
  };

  return {
    start: () => {
      eventWatch.start();
    },
    stop: () => {
      stopped = true;
      clearTimer();
      eventWatch.stop();
      stopping ??= cleanUp();

      return stopping;
    },
    requestScan: () => {
      eventWatch.requestScan();
    },
  };
};
