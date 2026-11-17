import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../../schema.js';

export const isQueuedHandover = (event: ToolResultEvent): boolean =>
  event.toolName === 'handover' && isRecord(event.details) && event.details['status'] === 'queued';
