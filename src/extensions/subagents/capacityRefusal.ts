import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent';

import { reportMessageType } from './reportDelivery.js';

interface MessageKind {
  role: string;
  customType?: string;
}

export class WorkerCapacityFullError extends Error {
  override name = 'WorkerCapacityFullError';
}

// A worker report ends a worker, so it frees a slot like a user message does.
const isWorkerReportNotice = (message: MessageKind): boolean =>
  message.role === 'custom' && message.customType === reportMessageType;

export const clearsCapacityRefusal = (message: MessageKind): boolean =>
  message.role === 'user' || isWorkerReportNotice(message);

export const capacityRefusalBlock = (capacityRefused: boolean): ToolCallEventResult | undefined => {
  if (!capacityRefused) {
    return undefined;
  }

  return {
    block: true,
    reason: 'Worker capacity was full. End your turn and retry after a worker stops.',
    terminate: true,
  };
};
