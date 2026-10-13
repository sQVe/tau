import { isRecord } from './isRecord.js';

export interface WorkerNoticeEvent {
  worker: string;
  label: string;
}

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
