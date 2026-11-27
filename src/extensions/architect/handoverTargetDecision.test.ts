import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { handoverSendTarget, handoverTargetRefusal } from './handoverTargetDecision.js';

const callEvent = (toolName: string, input: unknown): ToolCallEvent =>
  ({ type: 'tool_call', toolCallId: 'tool-call-1', toolName, input }) as unknown as ToolCallEvent;

const sendTable: {
  name: string;
  event: ToolCallEvent;
  expected: string | undefined;
}[] = [
  {
    name: 'reads the target of a handover send',
    event: callEvent('handover', { action: 'send', terminal: 't1' }),
    expected: 't1',
  },
  {
    name: 'allows a call that is not a handover',
    event: callEvent('bash', { action: 'send', terminal: 't1' }),
    expected: undefined,
  },
  {
    name: 'allows a handover call that is not a send',
    event: callEvent('handover', { action: 'read', terminal: 't1' }),
    expected: undefined,
  },
  {
    name: 'allows a handover send without a terminal string',
    event: callEvent('handover', { action: 'send', terminal: 1 }),
    expected: undefined,
  },
  {
    name: 'allows a handover call without an input object',
    event: callEvent('handover', null),
    expected: undefined,
  },
];

it.each(sendTable.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(handoverSendTarget(row.event)).toBe(row.expected);
});

const table: {
  name: string;
  target: string | undefined;
  leadTerminal: string | null | undefined;
  refused: boolean;
  names: readonly string[];
}[] = [
  {
    name: 'allows a send to the current lead',
    target: 't2',
    leadTerminal: 't2',
    refused: false,
    names: [],
  },
  {
    name: 'refuses a send to another terminal and names both',
    target: 't1',
    leadTerminal: 't2',
    refused: true,
    names: ['t1', 't2'],
  },
  {
    name: 'allows a send when no lead terminal is known',
    target: 't1',
    leadTerminal: null,
    refused: false,
    names: [],
  },
  {
    name: 'allows a send when the lead terminal is not set',
    target: 't1',
    leadTerminal: undefined,
    refused: false,
    names: [],
  },
  {
    name: 'allows a send when the lead terminal is empty',
    target: 't1',
    leadTerminal: '',
    refused: false,
    names: [],
  },
  {
    name: 'allows a call that is not a handover send',
    target: undefined,
    leadTerminal: 't2',
    refused: false,
    names: [],
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  const refusal = handoverTargetRefusal(row.target, row.leadTerminal);

  expect(refusal !== undefined).toBe(row.refused);

  for (const terminal of row.names) {
    expect(refusal).toContain(terminal);
  }
});
