import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../../schema.js';

const handoverDetails = (event: ToolResultEvent): Record<string, unknown> | undefined => {
  if (event.toolName !== 'handover' || !isRecord(event.details)) {
    return undefined;
  }

  return event.details;
};

export const isQueuedHandover = (event: ToolResultEvent): boolean =>
  handoverDetails(event)?.['status'] === 'queued';

export const finalHandoverStatus = (event: ToolResultEvent): 'queued' | 'unknown' | undefined => {
  const details = handoverDetails(event);

  if (details === undefined) {
    return undefined;
  }

  if (!isRecord(event.input) || event.input['final'] !== true) {
    return undefined;
  }

  const status = details['status'];

  return status === 'queued' || status === 'unknown' ? status : undefined;
};
