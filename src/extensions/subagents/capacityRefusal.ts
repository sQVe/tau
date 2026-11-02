import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent';

interface MessageKind {
  role: string;
}

export class WorkerCapacityFullError extends Error {
  override name = 'WorkerCapacityFullError';
}

export const clearsCapacityRefusal = (message: MessageKind): boolean => message.role === 'user';

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
