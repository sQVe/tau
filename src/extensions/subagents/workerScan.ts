import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { DeadlineWatchdog } from './deadlineWatchdog.js';
import { readWorkerChildren } from './workerDelivery.js';
import type { WorkerChildRead, WorkerDelivery } from './workerDelivery.js';

export type WorkerScanContext = Pick<ExtensionContext, 'sessionManager' | 'ui'>;

export interface WorkerScan {
  scan: (context: WorkerScanContext) => Promise<void>;
}

const notifyFailure = (context: WorkerScanContext, message: string): void => {
  try {
    context.ui.notify(message, 'error');
  } catch {
    // A replaced session makes its old context stale, so the error has nowhere to go.
  }
};

// Reads the children once per trigger, then runs delivery before the deadline step. A failed step
// does not stop the next one. The scans run one at a time.
export const createWorkerScan = (
  hc: HcRuntime,
  delivery: WorkerDelivery,
  deadline: DeadlineWatchdog,
): WorkerScan => {
  let tail: Promise<void> = Promise.resolve();

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

  const runScan = async (context: WorkerScanContext): Promise<void> => {
    const managerTerminal = currentTerminalAddress();

    if (managerTerminal === undefined) {
      return;
    }

    let children: WorkerChildRead[];

    try {
      children = await readWorkerChildren(hc, managerTerminal);
    } catch (error) {
      const message = errorMessage(error);

      notifyFailure(context, `Worker delivery failed: ${message}`);
      notifyFailure(context, `Deadline scan failed: ${message}`);

      return;
    }

    deliverChildren(context, children);

    try {
      await deadline.apply(context, managerTerminal, children);
    } catch (error) {
      notifyFailure(context, `Deadline scan failed: ${errorMessage(error)}`);
    }
  };

  return {
    scan: (context) => {
      const next = tail.then(() => runScan(context));

      tail = next.catch(() => undefined);

      return next;
    },
  };
};
