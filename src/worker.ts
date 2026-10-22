import { isRecord } from './schema.js';

export interface WorkerNoticeEvent {
  worker: string;
  label: string;
}

// The parent marks a worker process with its task record directory.
export const isWorkerProcess = (): boolean => {
  // oxlint-disable-next-line node/no-process-env -- The parent sets the marker in the worker pane environment.
  const recordDirectory = process.env.TAU_WORKER_RECORD;

  return recordDirectory != null && recordDirectory !== '';
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
