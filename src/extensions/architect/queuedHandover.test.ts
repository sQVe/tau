import type { ToolResultEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { finalHandoverResult, isQueuedHandover } from './queuedHandover.js';

const event = (toolName: string, details?: unknown, input?: unknown): ToolResultEvent =>
  ({ toolName, details, input }) as unknown as ToolResultEvent;

it.each([
  {
    name: 'a queued final handover keeps its resolved terminal',
    value: event(
      'handover',
      { status: 'queued', terminal: 't-lead' },
      { action: 'send', final: true },
    ),
    expected: { status: 'queued', terminal: 't-lead' },
  },
  {
    name: 'an unknown final handover keeps its resolved terminal',
    value: event(
      'handover',
      { status: 'unknown', terminal: 't-lead' },
      { action: 'send', final: true },
    ),
    expected: { status: 'unknown', terminal: 't-lead' },
  },
  {
    name: 'a final handover without a terminal has no resolved terminal',
    value: event('handover', { status: 'queued' }, { action: 'send', final: true }),
    expected: { status: 'queued', terminal: undefined },
  },
  {
    name: 'a non-final handover has no result',
    value: event(
      'handover',
      { status: 'queued', terminal: 't-lead' },
      { action: 'send', final: false },
    ),
    expected: undefined,
  },
  {
    name: 'another tool has no result',
    value: event(
      'other',
      { status: 'queued', terminal: 't-lead' },
      { action: 'send', final: true },
    ),
    expected: undefined,
  },
  {
    name: 'missing details has no result',
    value: event('handover', undefined, { action: 'send', final: true }),
    expected: undefined,
  },
  {
    name: 'another status has no result',
    value: event(
      'handover',
      { status: 'refused', terminal: 't-lead' },
      { action: 'send', final: true },
    ),
    expected: undefined,
  },
  {
    name: 'a queued handover with no input has no result',
    value: event('handover', { status: 'queued', terminal: 't-lead' }),
    expected: undefined,
  },
  {
    name: 'a queued handover with a string final has no result',
    value: event(
      'handover',
      { status: 'queued', terminal: 't-lead' },
      { action: 'send', final: 'true' },
    ),
    expected: undefined,
  },
] as const)('finalHandoverResult for $name', ({ value, expected }) => {
  expect(finalHandoverResult(value)).toEqual(expected);
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
