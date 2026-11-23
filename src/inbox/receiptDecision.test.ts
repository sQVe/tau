import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { parseSenderLine } from '../handoverSender.js';
import type { SavableMessageBody } from './protocol.js';
import {
  answeredQuestionId,
  decideCandidate,
  inboxMessageType,
  matchesReceipt,
  messageText,
  piQueueEmptyAtSettle,
  readInboxReceipt,
} from './receiptDecision.js';
import type { ReceiptedMessage, ReceiptEntryFact } from './receiptDecision.js';

const readTable = [
  {
    name: 'a version 2 handover receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: { version: 2, messageId: 'm1', sessionId: 's1', family: 'handover' },
  },
  {
    name: 'a version 2 answer receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer' },
    },
    receipt: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer' },
  },
  {
    name: 'an answer receipt with its question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer', questionId: 'q1' },
    },
    receipt: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer', questionId: 'q1' },
  },
  {
    name: 'an answer receipt with a malformed question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer', questionId: 1 },
    },
    receipt: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer' },
  },
  {
    name: 'a handover receipt with a question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 2,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover',
        questionId: 'q1',
      },
    },
    receipt: { version: 2, messageId: 'm1', sessionId: 's1', family: 'handover' },
  },
  {
    name: 'a version 2 handover-question receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 2,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-question',
        questionId: 'q1',
      },
    },
    receipt: {
      version: 2,
      messageId: 'm1',
      sessionId: 's1',
      family: 'handover-question',
      questionId: 'q1',
    },
  },
  {
    name: 'a version 1 receipt',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 1, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'a version 2 receipt of an answer-request family',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer-request' },
    },
    receipt: undefined,
  },
  {
    name: 'a version 2 receipt of an unknown family',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'other' },
    },
    receipt: undefined,
  },
  {
    name: 'an entry of another custom type',
    entry: {
      type: 'custom_message',
      customType: 'other',
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'an entry that is not a custom message',
    entry: {
      type: 'custom',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'a receipt with an empty message id',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: '', sessionId: 's1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'a receipt with an empty session id',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', sessionId: '', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'an entry without details',
    entry: { type: 'custom_message', customType: inboxMessageType },
    receipt: undefined,
  },
  {
    name: 'a version 3 receipt',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 3, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'a receipt without a message id',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, sessionId: 's1', family: 'handover' },
    },
    receipt: undefined,
  },
  {
    name: 'a receipt without a session id',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 2, messageId: 'm1', family: 'handover' },
    },
    receipt: undefined,
  },
] as const;

it.each(readTable.map((row) => [row.name, row] as const))('reads %s', (_name, row) => {
  expect(readInboxReceipt(row.entry)).toEqual(row.receipt);
});

const answerDetails = { version: 2, messageId: 'm1', sessionId: 's1', family: 'answer' };

const answeredTable = [
  {
    name: 'a started answer message',
    message: { customType: inboxMessageType, details: { ...answerDetails, questionId: 'q1' } },
    questionId: 'q1',
  },
  {
    name: 'an answer message without a question',
    message: { customType: inboxMessageType, details: answerDetails },
    questionId: undefined,
  },
  {
    name: 'a newer answer message',
    message: {
      customType: inboxMessageType,
      details: { ...answerDetails, version: 3, questionId: 'q1' },
    },
    questionId: undefined,
  },
  {
    name: 'a handover message with a question',
    message: {
      customType: inboxMessageType,
      details: { ...answerDetails, family: 'handover', questionId: 'q1' },
    },
    questionId: undefined,
  },
  {
    name: 'a handover-question message with a question',
    message: {
      customType: inboxMessageType,
      details: { ...answerDetails, family: 'handover-question', questionId: 'q1' },
    },
    questionId: undefined,
  },
  {
    name: 'a message of another custom type',
    message: { customType: 'other', details: { ...answerDetails, questionId: 'q1' } },
    questionId: undefined,
  },
] as const;

it.each(answeredTable.map((row) => [row.name, row] as const))(
  'reads the question of %s',
  (_name, row) => {
    expect(answeredQuestionId(row.message)).toBe(row.questionId);
  },
);

const receiptFixture = (name: string): ReceiptEntryFact =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures', 'receipt', name), 'utf8'),
  ) as ReceiptEntryFact;

const fixtureMessageId = '11111111-1111-4111-8111-111111111111';

it.each([
  {
    fixture: 'v2.json',
    receipt: { version: 2, messageId: fixtureMessageId, sessionId: 'session-1', family: 'answer' },
  },
  { fixture: 'newer.json', receipt: undefined },
  { fixture: 'malformed.json', receipt: undefined },
])('reads the frozen receipt fixture $fixture', ({ fixture, receipt }) => {
  expect(readInboxReceipt(receiptFixture(fixture))).toEqual(receipt);
});

const candidateTable = [
  {
    name: 'cleanup when the own receipt is saved',
    facts: { hasOwnReceipt: true, queued: false },
    step: 'cleanup',
  },
  {
    name: 'cleanup even while queued',
    facts: { hasOwnReceipt: true, queued: true },
    step: 'cleanup',
  },
  {
    name: 'pending while queued without a receipt',
    facts: { hasOwnReceipt: false, queued: true },
    step: 'pending',
  },
  {
    name: 'read without a receipt or queue',
    facts: { hasOwnReceipt: false, queued: false },
    step: 'read',
  },
] as const;

it.each(candidateTable.map((row) => [row.name, row] as const))('decides %s', (_name, row) => {
  expect(decideCandidate(row.facts)).toBe(row.step);
});

const handoverReceipt = {
  version: 2,
  messageId: 'm1',
  sessionId: 's1',
  family: 'handover',
} as const;

const sender = { terminal: 'lead', sessionId: 's1' };

const senderText = 'Handover sender: terminal lead, session s1.\n\nDo the task';

it.each([
  {
    name: 'with a sender',
    body: { family: 'handover', payload: { text: 'handover text', sender } } as const,
    text: 'Handover sender: terminal lead, session s1.\n\nhandover text',
  },
  {
    name: 'without a sender',
    body: { family: 'handover', payload: { text: 'handover text' } } as const,
    text: 'handover text',
  },
  {
    name: 'without a sender and with a sender line first',
    body: { family: 'handover', payload: { text: senderText } } as const,
    text: `Handover text without a sender:\n\n${senderText}`,
  },
  {
    name: 'with a sender and with another sender line first',
    body: { family: 'handover', payload: { text: senderText, sender } } as const,
    text: `Handover sender: terminal lead, session s1.\n\n${senderText}`,
  },
])('shows the handover text $name', ({ body, text }) => {
  expect(messageText(body)).toBe(text);
});

it('escapes sender-free text so it parses as no sender', () => {
  const text = messageText({ family: 'handover', payload: { text: senderText } });

  expect(parseSenderLine(text)).toBeUndefined();
});

const answerReceipt = { ...handoverReceipt, family: 'answer', questionId: 'q1' } as const;

const questionReceipt = {
  ...handoverReceipt,
  family: 'handover-question',
  questionId: 'q1',
} as const;

const questionPayload = {
  questionId: 'q1',
  text: 'Which option should I use?',
  askerTerminal: 'worker',
  askerSession: 's1',
};

const shownQuestionText =
  'Handover question q1 from terminal worker, session s1:\n\nWhich option should I use?';

const answerPayload = {
  assignmentId: 'a1',
  questionId: 'q1',
  parentSession: 'parent',
  answer: 'Use option A.',
};

const strayQuestionReceipt = {
  receipt: { ...handoverReceipt, questionId: 'q1' },
  content: 'handover text',
} as unknown as ReceiptedMessage;

const strayQuestionBody = {
  family: 'handover',
  payload: { text: 'handover text', questionId: 'q1' },
} as unknown as SavableMessageBody;

const retryTable = [
  {
    name: 'a handover retry with the shown text',
    receipted: { receipt: handoverReceipt, content: 'handover text' },
    body: { family: 'handover', payload: { text: 'handover text' } },
    matches: true,
  },
  {
    name: 'a handover retry with other text',
    receipted: { receipt: handoverReceipt, content: 'handover text' },
    body: { family: 'handover', payload: { text: 'other text' } },
    matches: false,
  },
  {
    name: 'a handover retry of an escaped sender-free message',
    receipted: {
      receipt: handoverReceipt,
      content: `Handover text without a sender:\n\n${senderText}`,
    },
    body: { family: 'handover', payload: { text: senderText } },
    matches: true,
  },
  {
    name: 'a handover retry saved before the sender escape',
    receipted: { receipt: handoverReceipt, content: senderText },
    body: { family: 'handover', payload: { text: senderText } },
    matches: true,
  },
  {
    name: 'a handover retry of unrelated saved content',
    receipted: { receipt: handoverReceipt, content: 'Unrelated saved text' },
    body: { family: 'handover', payload: { text: senderText } },
    matches: false,
  },
  {
    name: 'a handover retry with a sender whose receipt holds the payload text',
    receipted: { receipt: handoverReceipt, content: 'handover text' },
    body: { family: 'handover', payload: { text: 'handover text', sender } },
    matches: false,
  },
  {
    name: 'an answer retry of a receipt whose entry holds no text',
    receipted: { receipt: answerReceipt, content: undefined },
    body: { family: 'answer', payload: answerPayload },
    matches: false,
  },
  {
    name: 'a handover retry of a shown answer with the same text',
    receipted: { receipt: answerReceipt, content: 'Use option A.' },
    body: { family: 'handover', payload: { text: 'Use option A.' } },
    matches: false,
  },
  {
    name: 'a handover retry of a shown answer without a question',
    receipted: { receipt: { ...handoverReceipt, family: 'answer' }, content: 'handover text' },
    body: { family: 'handover', payload: { text: 'handover text' } },
    matches: false,
  },
  {
    name: 'an answer retry with the shown answer and question',
    receipted: { receipt: answerReceipt, content: 'Use option A.' },
    body: { family: 'answer', payload: answerPayload },
    matches: true,
  },
  {
    name: 'an answer retry for another question',
    receipted: { receipt: answerReceipt, content: 'Use option A.' },
    body: { family: 'answer', payload: { ...answerPayload, questionId: 'q2' } },
    matches: false,
  },
  {
    name: 'a handover-question retry with the shown text',
    receipted: { receipt: questionReceipt, content: shownQuestionText },
    body: { family: 'handover-question', payload: questionPayload },
    matches: true,
  },
  {
    name: 'a handover-question retry with another receipted question',
    receipted: { receipt: { ...questionReceipt, questionId: 'q2' }, content: shownQuestionText },
    body: { family: 'handover-question', payload: questionPayload },
    matches: false,
  },
  {
    name: 'a handover retry whose receipt holds a stray question',
    receipted: strayQuestionReceipt,
    body: { family: 'handover', payload: { text: 'handover text' } },
    matches: true,
  },
  {
    name: 'a handover retry whose body holds a stray question',
    receipted: { receipt: handoverReceipt, content: 'handover text' },
    body: strayQuestionBody,
    matches: true,
  },
  {
    name: 'a retry of a receipt whose entry holds no text',
    receipted: { receipt: handoverReceipt, content: undefined },
    body: { family: 'handover', payload: { text: 'handover text' } },
    matches: false,
  },
] as const;

it.each(retryTable.map((row) => [row.name, row] as const))(
  'matches the receipt for %s',
  (_name, row) => {
    expect(matchesReceipt(row.receipted, row.body)).toBe(row.matches);
  },
);

const settleTable = [
  {
    name: 'a settle without an abort in the terminal UI',
    facts: { aborted: false, mode: 'tui' },
    empty: true,
  },
  {
    name: 'a settle without an abort over RPC',
    facts: { aborted: false, mode: 'rpc' },
    empty: true,
  },
  {
    name: 'an aborted settle in the terminal UI',
    facts: { aborted: true, mode: 'tui' },
    empty: true,
  },
  { name: 'an aborted settle over RPC', facts: { aborted: true, mode: 'rpc' }, empty: false },
  {
    name: 'an aborted settle in print mode',
    facts: { aborted: true, mode: 'print' },
    empty: false,
  },
] as const;

it.each(settleTable.map((row) => [row.name, row] as const))(
  'decides whether the Pi queue is empty after %s',
  (_name, row) => {
    expect(piQueueEmptyAtSettle(row.facts)).toBe(row.empty);
  },
);
