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
  // Joins the runs queued so far. A retry that a timer scheduled is not part of the join, so a
  // caller clears first to cancel it.
  drain: () => Promise<void>;
}

type ScanOutcome = 'retry' | 'done';

const isRunAborted = (runtime: HcRuntime): boolean => runtime.signal?.aborted === true;

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

  const readSweepMessages = async (runtime: HcRuntime): Promise<string[]> => {
    try {
      const sweep = await sweepWorkerFolders(runtime, agentDirectory, Date.now, []);

      return sweep.errors;
    } catch (error) {
      return [errorMessage(error)];
    }
  };

  const sweepFolders = async (context: WorkerScanContext, runtime: HcRuntime): Promise<void> => {
    const messages = await readSweepMessages(runtime);

    for (const message of messages) {
      // A notification can shut the session down, which clears the run and its remaining messages.
      if (isRunAborted(runtime)) {
        return;
      }

      notifyFailure(context, `Worker folder sweep failed: ${message}`);
    }
  };

  const runDeadlineStep = async (
    context: WorkerScanContext,
    managerTerminal: string,
    children: readonly WorkerChildRead[],
    runtime: HcRuntime,
  ): Promise<void> => {
    try {
      await deadline.apply(context, managerTerminal, children, runtime);
    } catch (error) {
      if (!isRunAborted(runtime)) {
        notifyFailure(context, `Deadline scan failed: ${errorMessage(error)}`);
      }
    }
  };

  const scanSteps = async (
    context: WorkerScanContext,
    managerTerminal: string,
    runtime: HcRuntime,
  ): Promise<ScanOutcome> => {
    let children: WorkerChildRead[];

    try {
      children = await readWorkerChildren(runtime, managerTerminal);
    } catch (error) {
      if (isRunAborted(runtime)) {
        return 'done';
      }

      const message = errorMessage(error);

      notifyFailure(context, `Worker delivery failed: ${message}`);
      notifyFailure(context, `Deadline scan failed: ${message}`);

      return 'retry';
    }

    if (isRunAborted(runtime)) {
      return 'done';
    }

    attempt = 0;

    deliverChildren(context, children);

    await runDeadlineStep(context, managerTerminal, children, runtime);

    if (isRunAborted(runtime)) {
      return 'done';
    }

    await sweepFolders(context, runtime);

    return 'done';
  };

  const runScan = async (context: WorkerScanContext): Promise<ScanOutcome> => {
    const managerTerminal = currentTerminalAddress();

    if (managerTerminal === undefined) {
      return 'done';
    }

    const controller = new AbortController();
    const runtime: HcRuntime = { ...hc, signal: controller.signal };

    active = controller;

    try {
      return await scanSteps(context, managerTerminal, runtime);
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

      const outcome = await runScan(context);

      if (outcome === 'retry') {
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
