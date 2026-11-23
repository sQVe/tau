import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../../schema.js';

export const isQueuedHandover = (event: ToolResultEvent): boolean =>
  event.toolName === 'handover' && isRecord(event.details) && event.details['status'] === 'queued';

export const finalHandoverStatus = (event: ToolResultEvent): 'queued' | 'unknown' | undefined => {
  if (event.toolName !== 'handover' || !isRecord(event.details)) {
    return undefined;
  }

  if (!isRecord(event.input) || event.input['final'] !== true) {
    return undefined;
  }

  const status = event.details['status'];

  return status === 'queued' || status === 'unknown' ? status : undefined;
};

export const isFinalHandover = (event: ToolResultEvent): boolean =>
  finalHandoverStatus(event) === 'queued';
