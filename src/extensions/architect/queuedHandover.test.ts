import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { finalHandoverStatus, isQueuedHandover } from './queuedHandover.js';

const event = (toolName: string, details?: unknown, input?: unknown): ToolResultEvent =>
  ({ toolName, details, input }) as unknown as ToolResultEvent;

it.each([
  {
    name: 'a queued final handover is queued',
    value: event('handover', { status: 'queued' }, { action: 'send', final: true }),
    expected: 'queued',
  },
  {
    name: 'an unknown final handover is unknown',
    value: event('handover', { status: 'unknown' }, { action: 'send', final: true }),
    expected: 'unknown',
  },
  {
    name: 'a non-final handover has no status',
    value: event('handover', { status: 'queued' }, { action: 'send', final: false }),
    expected: undefined,
  },
  {
    name: 'another tool has no status',
    value: event('other', { status: 'queued' }, { action: 'send', final: true }),
    expected: undefined,
  },
  {
    name: 'missing details has no status',
    value: event('handover', undefined, { action: 'send', final: true }),
    expected: undefined,
  },
  {
    name: 'another status has no status',
    value: event('handover', { status: 'refused' }, { action: 'send', final: true }),
    expected: undefined,
  },
  {
    name: 'a queued handover with no input has no status',
    value: event('handover', { status: 'queued' }),
    expected: undefined,
  },
  {
    name: 'a queued handover with a string final has no status',
    value: event('handover', { status: 'queued' }, { action: 'send', final: 'true' }),
    expected: undefined,
  },
] as const)('finalHandoverStatus for $name', ({ value, expected }) => {
  expect(finalHandoverStatus(value)).toBe(expected);
});

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
