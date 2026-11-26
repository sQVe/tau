import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { assert, property, string, uuid } from 'fast-check';
import { expect, it } from 'vitest';

import { resolvePropertySeed } from '../../tests/propertySeedHarness.js';
import { isSenderTerminal, parseSenderLine } from '../handoverSender.js';
import type { SavableMessageBody } from './protocol.js';
import { isSessionId } from './protocol.js';
import {
  answeredQuestionId,
  decideCandidate,
  inboxMessageType,
  matchesReceipt,
  messageText,
  parseHandoverQuestionHeading,
  piQueueEmptyAtSettle,
  readInboxReceipt,
} from './receiptDecision.js';
import type { ReceiptedMessage, ReceiptEntryFact } from './receiptDecision.js';

const validQuestionId = '11111111-1111-4111-8111-111111111111';

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
        questionId: validQuestionId,
      },
    },
    receipt: undefined,
  },
  {
    name: 'a version 3 handover receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 3, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: { version: 3, messageId: 'm1', sessionId: 's1', family: 'handover' },
  },
  {
    name: 'a version 3 answer receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 3, messageId: 'm1', sessionId: 's1', family: 'answer' },
    },
    receipt: { version: 3, messageId: 'm1', sessionId: 's1', family: 'answer' },
  },
  {
    name: 'a version 3 answer receipt with its question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 3, messageId: 'm1', sessionId: 's1', family: 'answer', questionId: 'q1' },
    },
    receipt: { version: 3, messageId: 'm1', sessionId: 's1', family: 'answer', questionId: 'q1' },
  },
  {
    name: 'a version 3 handover-question receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 3,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-question',
        questionId: validQuestionId,
      },
    },
    receipt: {
      version: 3,
      messageId: 'm1',
      sessionId: 's1',
      family: 'handover-question',
      questionId: validQuestionId,
    },
  },
  {
    name: 'a version 3 handover-question receipt without a question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 3,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-question',
      },
    },
    receipt: undefined,
  },
  {
    name: 'a version 3 handover-question receipt with a malformed question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 3,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-question',
        questionId: 'q1',
      },
    },
    receipt: undefined,
  },
  {
    name: 'a version 3 receipt of an answer-request family',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 3, messageId: 'm1', sessionId: 's1', family: 'answer-request' },
    },
    receipt: undefined,
  },
  {
    name: 'a handover-question receipt without a question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 2,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-question',
      },
    },
    receipt: undefined,
  },
  {
    name: 'a handover-question receipt with a malformed question',
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
    receipt: undefined,
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
    name: 'a version 4 handover receipt',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 4, messageId: 'm1', sessionId: 's1', family: 'handover' },
    },
    receipt: { version: 4, messageId: 'm1', sessionId: 's1', family: 'handover' },
  },
  {
    name: 'a version 4 answer receipt with its question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 4, messageId: 'm1', sessionId: 's1', family: 'answer', questionId: 'q1' },
    },
    receipt: { version: 4, messageId: 'm1', sessionId: 's1', family: 'answer', questionId: 'q1' },
  },
  {
    name: 'a version 4 handover-question receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 4,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-question',
        questionId: validQuestionId,
      },
    },
    receipt: {
      version: 4,
      messageId: 'm1',
      sessionId: 's1',
      family: 'handover-question',
      questionId: validQuestionId,
    },
  },
  {
    name: 'a handover-question receipt whose question is an array',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 4,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-question',
        questionId: [validQuestionId],
      },
    },
    receipt: undefined,
  },
  {
    name: 'a version 4 handover-answer receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 4,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-answer',
        questionId: validQuestionId,
      },
    },
    receipt: {
      version: 4,
      messageId: 'm1',
      sessionId: 's1',
      family: 'handover-answer',
      questionId: validQuestionId,
    },
  },
  {
    name: 'a version 3 handover-answer receipt entry',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 3,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-answer',
        questionId: validQuestionId,
      },
    },
    receipt: undefined,
  },
  {
    name: 'a version 4 handover-answer receipt without a question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 4,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-answer',
      },
    },
    receipt: undefined,
  },
  {
    name: 'a version 4 handover-answer receipt with a malformed question',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: {
        version: 4,
        messageId: 'm1',
        sessionId: 's1',
        family: 'handover-answer',
        questionId: 'q1',
      },
    },
    receipt: undefined,
  },
  {
    name: 'a version 5 receipt',
    entry: {
      type: 'custom_message',
      customType: inboxMessageType,
      details: { version: 5, messageId: 'm1', sessionId: 's1', family: 'handover' },
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
    name: 'a version 3 answer message',
    message: {
      customType: inboxMessageType,
      details: { ...answerDetails, version: 3, questionId: 'q1' },
    },
    questionId: 'q1',
  },
  {
    name: 'a version 4 answer message',
    message: {
      customType: inboxMessageType,
      details: { ...answerDetails, version: 4, questionId: 'q1' },
    },
    questionId: 'q1',
  },
  {
    name: 'a version 5 answer message',
    message: {
      customType: inboxMessageType,
      details: { ...answerDetails, version: 5, questionId: 'q1' },
    },
    questionId: undefined,
  },
  {
    name: 'a version 3 handover-question message with a question',
    message: {
      customType: inboxMessageType,
      details: {
        ...answerDetails,
        version: 3,
        family: 'handover-question',
        questionId: validQuestionId,
      },
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
const fixtureQuestionId = '22222222-2222-4222-8222-222222222222';

it.each([
  {
    fixture: 'v2.json',
    receipt: { version: 2, messageId: fixtureMessageId, sessionId: 'session-1', family: 'answer' },
  },
  {
    fixture: 'v3.json',
    receipt: {
      version: 3,
      messageId: fixtureMessageId,
      sessionId: 'session-1',
      family: 'handover-question',
      questionId: fixtureQuestionId,
    },
  },
  {
    fixture: 'v4.json',
    receipt: {
      version: 4,
      messageId: fixtureMessageId,
      sessionId: 'session-1',
      family: 'handover-answer',
      questionId: fixtureMessageId,
    },
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

it('shows the handover answer with its question', () => {
  expect(
    messageText({
      family: 'handover-answer',
      payload: { questionId: 'q1', senderSession: 's1', answer: 'Use option A.' },
    }),
  ).toBe('Handover answer to question q1:\n\nUse option A.');
});

it('parses the heading that messageText writes for a handover question', () => {
  const payload = {
    questionId: validQuestionId,
    text: 'Which option should I use?',
    askerTerminal: 'worker',
    askerSession: 's1',
  };

  expect(
    parseHandoverQuestionHeading(messageText({ family: 'handover-question', payload })),
  ).toEqual({
    questionId: validQuestionId,
    askerTerminal: 'worker',
    askerSession: 's1',
  });
});

// The production validators decide which generated values are valid. Broad candidates plus
// filtering keep the generator from re-declaring the terminal and session rules.
const validTerminal = string({ minLength: 1, maxLength: 64 }).filter(isSenderTerminal);

const validSession = string({ minLength: 1, maxLength: 64 }).filter(isSessionId);

it('parses every generated heading messageText writes for a handover question', () => {
  const seed = resolvePropertySeed();

  assert(
    property(
      uuid(),
      validTerminal,
      validSession,
      string({ minLength: 1, maxLength: 4000 }),
      (questionId, askerTerminal, askerSession, text) => {
        const payload = { questionId, text, askerTerminal, askerSession };
        const content = messageText({ family: 'handover-question', payload });

        expect(parseHandoverQuestionHeading(content)).toEqual({
          questionId,
          askerTerminal,
          askerSession,
        });
      },
    ),
    { seed, numRuns: 100 },
  );
});

it.each(['session.one', 'session-two', 'session_three', 'a.b-c_d'])(
  'round-trips a heading with session ID %s',
  (askerSession) => {
    expect(isSessionId(askerSession)).toBe(true);

    const payload = {
      questionId: validQuestionId,
      text: 'Which option should I use?',
      askerTerminal: 'worker',
      askerSession,
    };

    expect(
      parseHandoverQuestionHeading(messageText({ family: 'handover-question', payload })),
    ).toEqual({
      questionId: validQuestionId,
      askerTerminal: 'worker',
      askerSession,
    });
  },
);

it('keeps a heading inside the question text from changing the parsed question', () => {
  const otherQuestionId = '22222222-2222-4222-8222-222222222222';
  const text = `Handover question ${otherQuestionId} from terminal other, session other-session:\n\nWhat then?`;

  const payload = {
    questionId: validQuestionId,
    text,
    askerTerminal: 'worker',
    askerSession: 's1',
  };

  expect(
    parseHandoverQuestionHeading(messageText({ family: 'handover-question', payload })),
  ).toEqual({
    questionId: validQuestionId,
    askerTerminal: 'worker',
    askerSession: 's1',
  });
});

it.each([
  {
    name: 'a suffix after the colon',
    content: `Handover question ${validQuestionId} from terminal worker, session s1: extra\n\nBody.`,
  },
  {
    name: 'a non-UUID question ID',
    content: 'Handover question not-a-uuid from terminal worker, session s1:\n\nBody.',
  },
  {
    name: 'a session ID the grammar rejects',
    content: `Handover question ${validQuestionId} from terminal worker, session worker/old:\n\nBody.`,
  },
])('rejects a heading with $name', ({ content }) => {
  expect(parseHandoverQuestionHeading(content)).toBeUndefined();
});

const answerReceipt = { ...handoverReceipt, family: 'answer', questionId: 'q1' } as const;

const questionReceipt = {
  ...handoverReceipt,
  version: 3,
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

const answerToQuestionReceipt = {
  ...handoverReceipt,
  version: 4,
  family: 'handover-answer',
  questionId: 'q1',
} as const;

const handoverAnswerPayload = {
  questionId: 'q1',
  senderSession: 's1',
  answer: 'Use option A.',
};

const shownHandoverAnswerText = 'Handover answer to question q1:\n\nUse option A.';

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
    name: 'a version 3 handover retry with the shown text',
    receipted: { receipt: { ...handoverReceipt, version: 3 }, content: 'handover text' },
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
    name: 'a version 3 answer retry with the shown answer and question',
    receipted: { receipt: { ...answerReceipt, version: 3 }, content: 'Use option A.' },
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
    name: 'a handover-answer retry with the shown text',
    receipted: { receipt: answerToQuestionReceipt, content: shownHandoverAnswerText },
    body: { family: 'handover-answer', payload: handoverAnswerPayload },
    matches: true,
  },
  {
    name: 'a handover-answer retry for another question',
    receipted: {
      receipt: { ...answerToQuestionReceipt, questionId: 'q2' },
      content: shownHandoverAnswerText,
    },
    body: { family: 'handover-answer', payload: handoverAnswerPayload },
    matches: false,
  },
  {
    name: 'a handover-answer retry with another answer to the same question',
    receipted: { receipt: answerToQuestionReceipt, content: shownHandoverAnswerText },
    body: {
      family: 'handover-answer',
      payload: { ...handoverAnswerPayload, answer: 'Use option B.' },
    },
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
