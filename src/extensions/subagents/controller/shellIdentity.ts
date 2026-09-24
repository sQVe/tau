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
): Promise<number> => {
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
        return shell;
      }

      previousShell = shell;
    } else {
      previousShell = undefined;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- Poll serially within the original startup budget.
    await delay(Math.min(100, workBudget(handle)), undefined, { signal: handle.abort.signal });
  }
};

// herdr 0.9.1 showed zsh prompt hooks inside the shell's process group, or as another group with no
// listed processes. A real job lists its group leader.
export const runsForegroundJob = (information: Record<string, unknown>): boolean => {
  const group = information.foreground_process_group_id;
  const processes = information.foreground_processes;

  return (
    group !== information.shell_pid &&
    Array.isArray(processes) &&
    processes.some((process) => requireObject(process).pid === group)
  );
};

// A shell briefly runs prompt hooks after startup and after each command. Resample it for about a
// second until sample returns true: the shell is settled, runs a real job, or has changed. The
// caller judges the last sample.
// ponytail: fixed window; derive it from the remaining budget if slow hooks outlast it.
export const settledShell = async (
  sample: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<void> => {
  // oxlint-disable-next-line eslint/no-await-in-loop -- Samples must observe the shell in order.
  for (let attempt = 1; attempt < 20 && !(await sample()); attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Resampling shares the caller's budget.
    await delay(50, undefined, { signal });
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
