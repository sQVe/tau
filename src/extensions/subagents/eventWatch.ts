import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../config/config.js';
import type { EventSubscription, HcEvent, SubscribeEvents } from '../../hc/events.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import { decideEventScan, decideReconnect } from './eventDecision.js';
import type { WorkerScan } from './workerScan.js';

export type EventWatchContext = Pick<
  ExtensionContext,
  'sessionManager' | 'ui' | 'isIdle' | 'signal'
>;

export interface EventWatch {
  start: (context: EventWatchContext) => void;
  stop: () => void;
}

export const createEventWatch = (subscribe: SubscribeEvents, scan: WorkerScan): EventWatch => {
  let stopped = true;
  let context: EventWatchContext | undefined;
  let subscription: EventSubscription | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;
  let connection = 0;
  let running = false;
  let pending = false;

  const runScans = async (): Promise<void> => {
    try {
      while (pending) {
        pending = false;

        if (stopped || context === undefined) {
          break;
        }

        // oxlint-disable-next-line eslint/no-await-in-loop -- the scans must run in order, not together.
        await scan.scan(context);
      }
    } finally {
      running = false;
    }
  };

  const requestScan = (): void => {
    if (running) {
      pending = true;

      return;
    }

    running = true;
    pending = true;
    runScans().catch(() => undefined);
  };

  const notify = (message: string, key: string): void => {
    if (context === undefined) {
      return;
    }

    try {
      notifyOnce(context.ui, 'worker-events', key, message, 'error');
    } catch {
      // A replaced session makes its old context stale, so the error has nowhere to go.
    }
  };

  const clearConnection = (): void => {
    connection += 1;

    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }

    subscription?.stop();
    subscription = undefined;
  };

  const connect = (): void => {
    const managerTerminal = currentTerminalAddress();

    if (stopped || managerTerminal === undefined) {
      return;
    }

    connection += 1;
    const connectionId = connection;

    subscription = subscribe(managerTerminal, {
      onReady: () => {
        if (connectionId !== connection) {
          return;
        }

        attempt = 0;
        generation += 1;
        requestScan();
      },
      onEvent: (event: HcEvent) => {
        if (connectionId !== connection) {
          return;
        }

        if (decideEventScan(event) === 'scan') {
          requestScan();
        }
      },
      onClose: (reason) => {
        if (connectionId !== connection) {
          return;
        }

        subscription = undefined;

        if (stopped) {
          return;
        }

        notify(`Worker event subscription closed: ${reason}`, `closed:${attempt}`);

        if (retry !== undefined) {
          return;
        }

        const plan = decideReconnect(attempt);

        if (plan.lasting) {
          notify('Worker event subscription keeps failing; retrying.', `lasting:${generation}`);
        }

        retry = setTimeout(() => {
          retry = undefined;
          attempt += 1;
          connect();
        }, plan.delay);
      },
    });
  };

  return {
    start: (newContext) => {
      clearConnection();
      context = newContext;
      stopped = false;
      attempt = 0;
      connect();
    },
    stop: () => {
      stopped = true;
      pending = false;
      clearConnection();
    },
  };
};
