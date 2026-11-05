import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { notifyOnce } from '../../config/config.js';
import type { SubscribeEvents } from '../../hc/events.js';
import { createEventWatch as createHcEventWatch } from '../../hc/eventWatch.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import { decideEventScan } from './eventDecision.js';
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
  let context: EventWatchContext | undefined;

  const watch = createHcEventWatch({
    subscribe,
    selector: () => {
      const managerTerminal = currentTerminalAddress();

      return managerTerminal === undefined ? undefined : { childrenOf: managerTerminal };
    },
    scan: () => (context === undefined ? Promise.resolve() : scan.scan(context)),
    isRelevant: (event) => decideEventScan(event) === 'scan',
    notify: (message, key) => {
      if (context === undefined) {
        return;
      }

      try {
        notifyOnce(context.ui, 'worker-events', key, message, 'error');
      } catch {
        // A replaced session makes its old context stale, so the error has nowhere to go.
      }
    },
  });

  return {
    start: (newContext) => {
      context = newContext;
      watch.start();
    },
    stop: () => {
      watch.stop();
    },
  };
};
