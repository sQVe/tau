import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { isQueuedHandover } from './queuedHandover.js';

const event = (toolName: string, details?: unknown): ToolResultEvent =>
  ({ toolName, details }) as unknown as ToolResultEvent;

it.each([
  {
    name: 'a handover with a queued status is queued',
    value: event('handover', { status: 'queued' }),
    expected: true,
  },
  {
    name: 'a handover with another status is not queued',
    value: event('handover', { status: 'unknown' }),
    expected: false,
  },
  {
    name: 'another tool with a queued status is not queued',
    value: event('other', { status: 'queued' }),
    expected: false,
  },
  {
    name: 'a handover whose details are not a record is not queued',
    value: event('handover', 'queued'),
    expected: false,
  },
  {
    name: 'a handover with no details is not queued',
    value: event('handover'),
    expected: false,
  },
] as const)('$name', ({ value, expected }) => {
  expect(isQueuedHandover(value)).toBe(expected);
});
