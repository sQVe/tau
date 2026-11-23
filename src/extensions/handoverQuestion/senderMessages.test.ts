import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { senderMessages } from './senderMessages.js';

const user = (content: unknown): SessionEntry =>
  ({ type: 'message', message: { role: 'user', content } }) as unknown as SessionEntry;

const inbox = (family: string, content: string): SessionEntry =>
  ({
    type: 'custom_message',
    customType: 'tau-inbox-message',
    content,
    display: true,
    details: {
      version: 2,
      messageId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      family,
    },
  }) as unknown as SessionEntry;

const custom = (content: string): SessionEntry =>
  ({
    type: 'custom_message',
    customType: 'tau-other-message',
    content,
    display: true,
    details: {},
  }) as unknown as SessionEntry;

it.each([
  {
    name: 'reads the first user message only',
    entries: [user('first task'), user('second task')],
    expected: ['first task'],
  },
  {
    name: 'reads the text blocks of the first user message',
    entries: [
      user([
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: 'first task' },
      ]),
    ],
    expected: ['first task'],
  },
  {
    name: 'keeps handover receipts in branch order',
    entries: [
      user('first task'),
      inbox('handover', 'Handover sender: terminal lead-1, session s1.\n\nOne.'),
      inbox('answer', 'An answer.'),
      inbox('handover-question', 'A question.'),
      inbox('handover', 'Handover sender: terminal lead-2, session s2.\n\nTwo.'),
    ],
    expected: [
      'first task',
      'Handover sender: terminal lead-1, session s1.\n\nOne.',
      'Handover sender: terminal lead-2, session s2.\n\nTwo.',
    ],
  },
  {
    name: 'skips other custom messages',
    entries: [custom('Another message.'), user('first task'), custom('And another.')],
    expected: ['first task'],
  },
  {
    name: 'reads no message as an empty list',
    entries: [],
    expected: [],
  },
])('$name', ({ entries, expected }) => {
  expect(senderMessages(entries)).toEqual(expected);
});
