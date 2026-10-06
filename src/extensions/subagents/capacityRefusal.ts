import type { ToolCallEventResult } from '@earendil-works/pi-coding-agent';

interface MessageKind {
  role: string;
  customType?: string;
}

export const clearsCapacityRefusal = (message: MessageKind): boolean => {
  const workerNotice = message.role === 'custom' && message.customType === 'tau-worker';

  return message.role === 'user' || workerNotice;
};

export const capacityRefusalBlock = (capacityRefused: boolean): ToolCallEventResult | undefined => {
  if (!capacityRefused) {
    return undefined;
  }

  return {
    block: true,
    reason: 'Worker capacity was full. End your turn and wait for a worker notice.',
    terminate: true,
  };
};
