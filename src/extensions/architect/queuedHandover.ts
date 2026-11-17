import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../../schema.js';

export const isQueuedHandover = (event: ToolResultEvent): boolean =>
  event.toolName === 'handover' && isRecord(event.details) && event.details['status'] === 'queued';

export const isFinalHandover = (event: ToolResultEvent): boolean =>
  isQueuedHandover(event) && isRecord(event.input) && event.input['final'] === true;
