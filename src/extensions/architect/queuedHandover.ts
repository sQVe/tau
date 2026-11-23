import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../../schema.js';

export interface FinalHandoverResult {
  status: 'queued' | 'unknown';
  terminal: string | undefined;
}

const handoverDetails = (event: ToolResultEvent): Record<string, unknown> | undefined => {
  if (event.toolName !== 'handover' || !isRecord(event.details)) {
    return undefined;
  }

  return event.details;
};

export const isQueuedHandover = (event: ToolResultEvent): boolean =>
  handoverDetails(event)?.['status'] === 'queued';

export const finalHandoverResult = (event: ToolResultEvent): FinalHandoverResult | undefined => {
  const details = handoverDetails(event);

  if (details === undefined) {
    return undefined;
  }

  if (!isRecord(event.input) || event.input['final'] !== true) {
    return undefined;
  }

  const status = details['status'];
  const terminal = details['terminal'];

  if (status !== 'queued' && status !== 'unknown') {
    return undefined;
  }

  return { status, terminal: typeof terminal === 'string' ? terminal : undefined };
};
