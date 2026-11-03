import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { retryDelay } from './deadlineDecision.js';
import type { DeadlineWatchdog } from './deadlineWatchdog.js';
import { readWorkerChildren } from './workerDelivery.js';
import type { WorkerChildRead, WorkerDelivery } from './workerDelivery.js';

export type WorkerScanContext = Pick<ExtensionContext, 'sessionManager' | 'ui'>;

export interface WorkerScan {
  scan: (context: WorkerScanContext) => Promise<void>;
  clear: () => void;
}

const notifyFailure = (context: WorkerScanContext, message: string): void => {
  try {
    context.ui.notify(message, 'error');
  } catch {
    // A replaced session makes its old context stale, so the error has nowhere to go.
  }
};

export const createWorkerScan = (
  hc: HcRuntime,
  delivery: WorkerDelivery,
  deadline: DeadlineWatchdog,
): WorkerScan => {
  let tail: Promise<void> = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const clearRetry = (): void => {
    if (retry === undefined) {
      return;
    }

    clearTimeout(retry);
    retry = undefined;
  };

  const scheduleRetry = (run: () => Promise<void>): void => {
    if (stopped || retry !== undefined) {
      return;
    }

    const delay = retryDelay(attempt);

    if (delay === undefined) {
      return;
    }

    retry = setTimeout(() => {
      retry = undefined;
      attempt += 1;

      run().catch(() => undefined);
    }, delay);
  };

  const deliverChildren = (
    context: WorkerScanContext,
    children: readonly WorkerChildRead[],
  ): void => {
    try {
      delivery.deliver(context, children);
    } catch (error) {
      notifyFailure(context, `Worker delivery failed: ${errorMessage(error)}`);
    }
  };

  const runScan = async (context: WorkerScanContext): Promise<boolean> => {
    const managerTerminal = currentTerminalAddress();

    if (managerTerminal === undefined) {
      return false;
    }

    let children: WorkerChildRead[];

    try {
      children = await readWorkerChildren(hc, managerTerminal);
    } catch (error) {
      const message = errorMessage(error);

      notifyFailure(context, `Worker delivery failed: ${message}`);
      notifyFailure(context, `Deadline scan failed: ${message}`);

      return true;
    }

    attempt = 0;

    deliverChildren(context, children);

    try {
      await deadline.apply(context, managerTerminal, children);
    } catch (error) {
      notifyFailure(context, `Deadline scan failed: ${errorMessage(error)}`);
    }

    return false;
  };

  const enqueue = (context: WorkerScanContext, isRetry: boolean): Promise<void> => {
    const next = tail.then(async () => {
      if (isRetry && stopped) {
        return undefined;
      }

      const failed = await runScan(context);

      if (failed) {
        scheduleRetry(() => enqueue(context, true));
      }

      return undefined;
    });

    tail = next.catch(() => undefined);

    return next;
  };

  const scan = (context: WorkerScanContext): Promise<void> => enqueue(context, false);

  return {
    scan,
    clear: () => {
      stopped = true;
      clearRetry();
    },
  };
};
