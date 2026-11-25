import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { assistantCalls, entryMessage } from './sessionMessage.ts';
import type { AssistantCalls, DroppedCall } from './sessionMessage.ts';

const entry = (type: string, message: unknown) => ({ type, message }) as unknown as SessionEntry;

const entryTable: {
  name: string;
  entry: SessionEntry;
  expected: Record<string, unknown> | undefined;
}[] = [
  {
    name: 'a message entry gives its message',
    entry: entry('message', { role: 'assistant', content: [] }),
    expected: { role: 'assistant', content: [] },
  },
  {
    name: 'another entry type gives nothing',
    entry: entry('custom', { role: 'assistant' }),
    expected: undefined,
  },
  {
    name: 'a message that is a string gives nothing',
    entry: entry('message', 'text'),
    expected: undefined,
  },
  {
    name: 'a message that is an array gives nothing',
    entry: entry('message', []),
    expected: undefined,
  },
  {
    name: 'a missing message gives nothing',
    entry: { type: 'message' } as unknown as SessionEntry,
    expected: undefined,
  },
];

it.each(entryTable.map((row) => [row.name, row] as const))(
  'entryMessage: %s',
  (_name, { entry: input, expected }) => {
    expect(entryMessage(input)).toEqual(expected);
  },
);

const call = (fields: Record<string, unknown>) => ({ type: 'toolCall', ...fields });

const dropped = (callId: string | undefined, tool: string | undefined): DroppedCall => ({
  callId,
  tool,
});

const callsTable: { name: string; message: Record<string, unknown>; expected: AssistantCalls }[] = [
  {
    name: 'keeps a call with its arguments',
    message: {
      role: 'assistant',
      content: [call({ id: 'call-1', name: 'full_check', arguments: { passed: true } })],
    },
    expected: {
      calls: [{ callId: 'call-1', tool: 'full_check', arguments: { passed: true } }],
      dropped: [],
    },
  },
  {
    name: 'omits arguments that are not a record',
    message: {
      role: 'assistant',
      content: [call({ id: 'call-1', name: 'full_check', arguments: 'passed' })],
    },
    expected: { calls: [{ callId: 'call-1', tool: 'full_check' }], dropped: [] },
  },
  {
    name: 'drops a call without a name',
    message: {
      role: 'assistant',
      content: [call({ id: 'call-1', arguments: {} })],
    },
    expected: { calls: [], dropped: [dropped('call-1', undefined)] },
  },
  {
    name: 'drops a call without an id',
    message: {
      role: 'assistant',
      content: [call({ name: 'full_check', arguments: {} })],
    },
    expected: { calls: [], dropped: [dropped(undefined, 'full_check')] },
  },
  {
    name: 'ignores blocks that are not tool calls',
    message: {
      role: 'assistant',
      content: [null, 'text', { type: 'text', text: 'Hi' }, call({ id: 'call-1', name: 'pr' })],
    },
    expected: { calls: [{ callId: 'call-1', tool: 'pr' }], dropped: [] },
  },
  {
    name: 'keeps calls in order',
    message: {
      role: 'assistant',
      content: [call({ id: 'call-1', name: 'pr' }), call({ id: 'call-2', name: 'full_check' })],
    },
    expected: {
      calls: [
        { callId: 'call-1', tool: 'pr' },
        { callId: 'call-2', tool: 'full_check' },
      ],
      dropped: [],
    },
  },
  {
    name: 'gives nothing for content that is not an array',
    message: { role: 'assistant', content: 'text' },
    expected: { calls: [], dropped: [] },
  },
  {
    name: 'does not check the role',
    message: {
      role: 'toolResult',
      content: [call({ id: 'call-1', name: 'pr' })],
    },
    expected: { calls: [{ callId: 'call-1', tool: 'pr' }], dropped: [] },
  },
];

it.each(callsTable.map((row) => [row.name, row] as const))(
  'assistantCalls: %s',
  (_name, { message, expected }) => {
    expect(assistantCalls(message)).toEqual(expected);
  },
);

it('drops a tool call whose id is not a string', () => {
  const message = {
    role: 'assistant',
    content: [call({ id: 5, name: 'full_check', arguments: {} })],
  };

  expect(assistantCalls(message)).toEqual({
    calls: [],
    dropped: [dropped(undefined, 'full_check')],
  });
});

it('gives a tool call with no argument record no arguments property', () => {
  const argumentCases = [
    call({ id: 'call-1', name: 'full_check', arguments: 'passed' }),
    call({ id: 'call-1', name: 'full_check' }),
  ];

  for (const block of argumentCases) {
    const found = assistantCalls({ role: 'assistant', content: [block] });

    expect(found.calls).toEqual([{ callId: 'call-1', tool: 'full_check' }]);
    expect(found.calls[0]).not.toHaveProperty('arguments');
  }
});
