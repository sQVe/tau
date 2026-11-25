import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import type { HcRuntime } from '../../hc/hc.js';
import { retryDelay } from './deadlineDecision.js';
import type { DeadlineWatchdog } from './deadlineWatchdog.js';
import { readWorkerChildren } from './workerDelivery.js';
import type { WorkerChildRead, WorkerDelivery } from './workerDelivery.js';
import { sweepWorkerFolders } from './workerFolderSweep.js';

export type WorkerScanContext = Pick<
  ExtensionContext,
  'sessionManager' | 'ui' | 'isIdle' | 'signal'
>;

export interface WorkerScan {
  scan: (context: WorkerScanContext) => Promise<void>;
  clear: () => void;
  drain: () => Promise<void>;
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
  agentDirectory: string,
): WorkerScan => {
  let tail: Promise<void> = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;
  let clears = 0;
  let active: AbortController | undefined;

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

  const sweepFolders = async (
    context: WorkerScanContext,
    runtime: HcRuntime,
    signal: AbortSignal,
  ): Promise<void> => {
    let messages: string[];

    try {
      const sweep = await sweepWorkerFolders(runtime, agentDirectory, Date.now, []);

      messages = sweep.errors;
    } catch (error) {
      messages = [errorMessage(error)];
    }

    if (signal.aborted) {
      return;
    }

    for (const message of messages) {
      notifyFailure(context, `Worker folder sweep failed: ${message}`);
    }
  };

  const runScan = async (context: WorkerScanContext): Promise<boolean> => {
    const managerTerminal = currentTerminalAddress();

    if (managerTerminal === undefined) {
      return false;
    }

    const controller = new AbortController();
    const runtime: HcRuntime = { ...hc, signal: controller.signal };

    active = controller;

    try {
      let children: WorkerChildRead[];

      try {
        children = await readWorkerChildren(runtime, managerTerminal);
      } catch (error) {
        if (controller.signal.aborted) {
          return false;
        }

        const message = errorMessage(error);

        notifyFailure(context, `Worker delivery failed: ${message}`);
        notifyFailure(context, `Deadline scan failed: ${message}`);

        return true;
      }

      if (controller.signal.aborted) {
        return false;
      }

      attempt = 0;

      deliverChildren(context, children);

      try {
        await deadline.apply(context, managerTerminal, children, runtime);
      } catch (error) {
        notifyFailure(context, `Deadline scan failed: ${errorMessage(error)}`);
      }

      await sweepFolders(context, runtime, controller.signal);

      return false;
    } finally {
      active = undefined;
    }
  };

  const enqueue = (context: WorkerScanContext): Promise<void> => {
    const queuedAt = clears;

    const next = tail.then(async () => {
      if (queuedAt !== clears) {
        return undefined;
      }

      const failed = await runScan(context);

      if (failed) {
        scheduleRetry(() => enqueue(context));
      }

      return undefined;
    });

    tail = next.catch(() => undefined);

    return next;
  };

  const scan = (context: WorkerScanContext): Promise<void> => enqueue(context);

  return {
    scan,
    clear: () => {
      clears += 1;
      stopped = true;
      clearRetry();
      active?.abort();
    },
    drain: () => tail,
  };
};
