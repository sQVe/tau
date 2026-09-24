import { setTimeout as delay } from 'node:timers/promises';

import { processAbsent, runClient } from '../cancellation.js';
import { requireObject, result } from '../terminal.js';
import type { TerminalCall } from '../terminal.js';
import { workBudget } from './budget.js';
import type { Handle } from './types.js';

export const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error('Invalid herdr process identity.');
  }

  return Number(value);
};

export const isBareShell = (information: Record<string, unknown>): boolean => {
  const processes = information.foreground_processes;
  const shellPid = integer(information.shell_pid);
  const shellAlone =
    Array.isArray(processes) &&
    processes.length === 1 &&
    requireObject(processes[0]).pid === shellPid;

  return information.foreground_process_group_id === shellPid && shellAlone;
};

export const waitForShell = async (
  handle: Handle,
  paneId: string,
  call: TerminalCall,
): Promise<void> => {
  let previousShell: number | undefined;

  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Shell startup polling shares the original launch budget.
    const response = await call(['pane', 'process-info', '--pane', paneId]);
    const information = requireObject(result(response).process_info);

    if (information.pane_id !== paneId) {
      throw new Error('Shell pane identity changed before startup.');
    }

    if (isBareShell(information)) {
      const shell = integer(information.shell_pid);

      if (shell === previousShell) {
        return;
      }

      previousShell = shell;
    } else {
      previousShell = undefined;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll serially within the original startup budget.
    await delay(Math.min(100, workBudget(handle)), undefined, { signal: handle.abort.signal });
  }
};

export class WorkerExitedError extends Error {
  override name = 'WorkerExitedError';

  constructor(options?: ErrorOptions) {
    super('Worker exited before readiness. No task dispatch or retry.', options);
  }
}

export interface InspectionBudget {
  remainingBudget: () => number;
  signal: AbortSignal;
}

export const readProcessStart = async (
  handle: Handle,
  processId: number,
  cleanup?: InspectionBudget,
): Promise<string> => {
  const processStart = await runClient(
    'ps',
    ['-p', String(processId), '-o', 'lstart='],
    cleanup ? Math.min(1000, cleanup.remainingBudget()) : workBudget(handle, 1000),
    { signal: cleanup?.signal ?? handle.abort.signal },
  ).catch((error: unknown) => {
    if (processAbsent(processId)) {
      throw new WorkerExitedError({ cause: error });
    }

    throw error;
  });

  return processStart.trim();
};
