import { processAbsent, runClient } from '../cancellation.js';
import { workBudget } from './budget.js';
import type { Handle } from './types.js';

export interface InspectionBudget {
  remainingBudget: () => number;
  signal: AbortSignal;
}

export const integer = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error('Invalid herdr process identity.');
  }

  return Number(value);
};

export class WorkerExitedError extends Error {
  override name = 'WorkerExitedError';

  constructor(options?: ErrorOptions) {
    super('Worker exited before readiness. No task dispatch or retry.', options);
  }
}

const processStartBudget = 1000;

export const readProcessStart = async (
  handle: Handle,
  processId: number,
  cleanup?: InspectionBudget,
): Promise<string> => {
  const processStart = await runClient(
    'ps',
    ['-p', String(processId), '-o', 'lstart='],
    cleanup
      ? Math.min(processStartBudget, cleanup.remainingBudget())
      : workBudget(handle, processStartBudget),
    { signal: cleanup?.signal ?? handle.abort.signal },
  ).catch((error: unknown) => {
    if (processAbsent(processId)) {
      throw new WorkerExitedError({ cause: error });
    }

    throw error;
  });

  return processStart.trim();
};
