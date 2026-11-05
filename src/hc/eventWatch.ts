import type { EventSelector, EventSubscription, HcEvent, SubscribeEvents } from './events.js';
import { decideReconnect } from './reconnect.js';

export interface EventWatch {
  start: () => void;
  stop: () => void;
  requestScan: () => void;
}

export interface EventWatchOptions {
  subscribe: SubscribeEvents;
  selector: () => EventSelector | undefined;
  scan: () => Promise<void>;
  isRelevant: (event: HcEvent) => boolean;
  notify: (message: string, key: string) => void;
}

// The generation that last reported a close or a lasting outage. A generation changes after a
// ready subscription, so each outage reports its close and its lasting failure at most once.
const createOutage = () => {
  let closed = -1;
  let lasting = -1;

  return {
    close: (generation: number): boolean => {
      const fresh = generation !== closed;

      closed = generation;

      return fresh;
    },
    lasting: (generation: number): boolean => {
      const fresh = generation !== lasting;

      lasting = generation;

      return fresh;
    },
    reset: (): void => {
      closed = -1;
      lasting = -1;
    },
  };
};

export const createEventWatch = (options: EventWatchOptions): EventWatch => {
  let stopped = true;
  let subscription: EventSubscription | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let generation = 0;
  let connection = 0;
  let running = false;
  let pending = false;
  const outage = createOutage();

  const runScans = async (): Promise<void> => {
    try {
      while (pending) {
        pending = false;

        if (stopped) {
          break;
        }

        // oxlint-disable-next-line eslint/no-await-in-loop -- the scans must run in order, not together.
        await options.scan();
      }
    } finally {
      running = false;
    }
  };

  const requestScan = (): void => {
    if (stopped) {
      return;
    }

    if (running) {
      pending = true;

      return;
    }

    running = true;
    pending = true;
    runScans().catch(() => undefined);
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
    if (stopped) {
      return;
    }

    const selector = options.selector();

    if (selector === undefined) {
      return;
    }

    connection += 1;
    const connectionId = connection;

    subscription = options.subscribe(selector, {
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

        if (options.isRelevant(event)) {
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

        if (outage.close(generation)) {
          options.notify(`Event subscription closed: ${reason}`, `closed:${generation}`);
        }

        if (retry !== undefined) {
          return;
        }

        const plan = decideReconnect(attempt);

        if (plan.lasting && outage.lasting(generation)) {
          options.notify('Event subscription keeps failing; retrying.', `lasting:${generation}`);
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
    start: () => {
      clearConnection();
      outage.reset();
      stopped = false;
      attempt = 0;
      connect();
    },
    stop: () => {
      stopped = true;
      pending = false;
      clearConnection();
    },
    requestScan,
  };
};
