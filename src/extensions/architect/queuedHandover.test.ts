import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { isFinalHandover, isQueuedHandover } from './queuedHandover.js';

const event = (toolName: string, details?: unknown, input?: unknown): ToolResultEvent =>
  ({ toolName, details, input }) as unknown as ToolResultEvent;

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

it.each([
  {
    name: 'a queued handover with final true is final',
    value: event('handover', { status: 'queued' }, { action: 'send', final: true }),
    expected: true,
  },
  {
    name: 'a queued handover with final false is not final',
    value: event('handover', { status: 'queued' }, { action: 'send', final: false }),
    expected: false,
  },
  {
    name: 'a queued handover with no input is not final',
    value: event('handover', { status: 'queued' }),
    expected: false,
  },
  {
    name: 'a queued handover with a string final is not final',
    value: event('handover', { status: 'queued' }, { action: 'send', final: 'true' }),
    expected: false,
  },
  {
    name: 'an unknown handover with final true is not final',
    value: event('handover', { status: 'unknown' }, { action: 'send', final: true }),
    expected: false,
  },
] as const)('$name', ({ value, expected }) => {
  expect(isFinalHandover(value)).toBe(expected);
});
