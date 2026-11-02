import { isRecord } from './schema.js';

export interface WorkerNoticeEvent {
  worker: string;
  label: string;
}

// The parent marks a worker process with TAU_ROLE=worker in the worker pane environment.
export const isWorkerProcess = (): boolean => {
  // oxlint-disable-next-line node/no-process-env -- The parent sets the marker in the worker pane environment.
  return process.env.TAU_ROLE === 'worker';
};

export const workerNoticeChannel = 'tau:worker-notice';

export const parseWorkerNoticeEvent = (data: unknown): WorkerNoticeEvent | undefined => {
  if (!isRecord(data)) {
    return undefined;
  }

  const { worker, label } = data;

  if (typeof worker !== 'string' || typeof label !== 'string') {
    return undefined;
  }

  return { worker, label };
};
