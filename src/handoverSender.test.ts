import { expect, it } from 'vitest';

import {
  lookupSender,
  parseSenderLine,
  senderEnvironment,
  senderEnvironmentNames,
  senderLine,
  senderOf,
} from './handoverSender.js';
import type { HandoverSender } from './handoverSender.js';

const lead: HandoverSender = { terminal: 't7', sessionId: 'lead-id' };

const senderLineOf = (sender: HandoverSender): string =>
  `Handover sender: terminal ${sender.terminal}, session ${sender.sessionId}.`;

const lookupRows: {
  name: string;
  environment: Record<string, string | undefined>;
  messages: readonly string[];
  expected: HandoverSender | undefined;
}[] = [
  {
    name: 'takes the sender from the environment',
    environment: {
      TAU_HANDOVER_SENDER_TERMINAL: 't7',
      TAU_HANDOVER_SENDER_SESSION: 'lead-id',
    },
    messages: [],
    expected: lead,
  },
  {
    name: 'takes the sender from a task message with no environment',
    environment: {},
    messages: [`${senderLineOf(lead)}\n\nDo the task`],
    expected: lead,
  },
  {
    name: 'takes the newest sender from a newer handover message',
    environment: {},
    messages: [
      `Handover sender: terminal t1, session old-id.\n\nDo the task`,
      `${senderLineOf(lead)}\n\nNext steps`,
    ],
    expected: lead,
  },
  {
    name: 'keeps the older sender when a newer handover has no sender line',
    environment: {},
    messages: [`Handover sender: terminal t1, session old-id.\n\nDo the task`, 'Next steps'],
    expected: { terminal: 't1', sessionId: 'old-id' },
  },
  {
    name: 'takes no sender without a line and without an environment',
    environment: {},
    messages: [],
    expected: undefined,
  },
  {
    name: 'takes no sender from one environment variable alone',
    environment: { TAU_HANDOVER_SENDER_TERMINAL: 't7' },
    messages: [],
    expected: undefined,
  },
  {
    name: 'takes no sender from a session environment variable alone',
    environment: { TAU_HANDOVER_SENDER_SESSION: 'lead-id' },
    messages: [],
    expected: undefined,
  },
  {
    name: 'takes no sender from a malformed session ID in the environment',
    environment: {
      TAU_HANDOVER_SENDER_TERMINAL: 't7',
      TAU_HANDOVER_SENDER_SESSION: 'lead id',
    },
    messages: [],
    expected: undefined,
  },
  {
    name: 'takes no sender from a malformed sender line',
    environment: {},
    messages: ['Handover sender: terminal t7, session lead id.\n\nDo the task'],
    expected: undefined,
  },
  {
    name: 'takes no sender from a line with a trailing session period',
    environment: {},
    messages: ['Handover sender: terminal t7, session lead-id..\n\nDo the task'],
    expected: undefined,
  },
  {
    name: 'prefers a newer sender line over the environment',
    environment: {
      TAU_HANDOVER_SENDER_TERMINAL: 't1',
      TAU_HANDOVER_SENDER_SESSION: 'old-id',
    },
    messages: [`${senderLineOf(lead)}\n\nNext steps`],
    expected: lead,
  },
];

it.each(lookupRows.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(lookupSender({ environment: row.environment, messages: row.messages })).toStrictEqual(
    row.expected,
  );
});

const senderOfRows: {
  name: string;
  role: string;
  terminal: string | undefined;
  sessionId: string | undefined;
  expected: HandoverSender | undefined;
}[] = [
  {
    name: 'takes a lead with a terminal and a session',
    role: 'lead',
    terminal: 't7',
    sessionId: 'lead-id',
    expected: lead,
  },
  {
    name: 'takes no architect',
    role: 'architect',
    terminal: 't7',
    sessionId: 'lead-id',
    expected: undefined,
  },
  {
    name: 'takes no worker',
    role: 'worker',
    terminal: 't7',
    sessionId: 'lead-id',
    expected: undefined,
  },
  {
    name: 'takes no missing terminal',
    role: 'lead',
    terminal: undefined,
    sessionId: 'lead-id',
    expected: undefined,
  },
  {
    name: 'takes no empty session',
    role: 'lead',
    terminal: 't7',
    sessionId: '',
    expected: undefined,
  },
];

it.each(senderOfRows.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(
    senderOf({ role: row.role, terminal: row.terminal, sessionId: row.sessionId }),
  ).toStrictEqual(row.expected);
});

const terminals = ['t7', 't-child', 'lead', 'x'];
const sessionIds = ['lead-id', 'A', 'a.b_c-1', '0', '9-9'];

it.each(
  terminals.flatMap((terminal) => sessionIds.map((sessionId) => [terminal, sessionId] as const)),
)('round-trips a sender line for terminal %s and session %s', (terminal, sessionId) => {
  const sender = { terminal, sessionId };

  expect(parseSenderLine(senderLine(sender))).toStrictEqual(sender);
});

it('names the sender environment variables', () => {
  expect(senderEnvironment(lead)).toStrictEqual({
    [senderEnvironmentNames.terminal]: 't7',
    [senderEnvironmentNames.session]: 'lead-id',
  });
});
