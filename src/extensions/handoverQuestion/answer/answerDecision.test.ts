import { expect, it } from 'vitest';

import { answeredRecord, openRecord } from '../../../../tests/fixtures/answerRecord.js';
import type { AnswerFacts } from './answerDecision.js';
import { decideAnswer } from './answerDecision.js';

const questionId = '11111111-1111-4111-8111-111111111111';
const targetSessionId = '22222222-2222-4222-8222-222222222222';
const senderSession = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const otherSession = '55555555-5555-4555-8555-555555555555';
const answer = 'Use option A.';

const payload = { questionId, senderSession, answer };

const facts = (overrides: Partial<AnswerFacts> = {}): AnswerFacts => ({
  messageId: questionId,
  targetSessionId,
  payload,
  read: { kind: 'record', record: openRecord(senderSession) },
  ...overrides,
});

it.each([
  {
    name: 'refuses a message ID other than the question ID',
    given: facts({ messageId: otherId }),
    expected: {
      kind: 'refuse',
      reason: 'A handover answer must use its question ID as its message ID.',
    },
  },
  {
    name: 'refuses a missing question record',
    given: facts({ read: { kind: 'missing' } }),
    expected: {
      kind: 'refuse',
      reason: `This session asked no handover question ${questionId}.`,
    },
  },
  {
    name: 'refuses a malformed question record',
    given: facts({ read: { kind: 'malformed', reason: 'Unreadable.' } }),
    expected: {
      kind: 'refuse',
      reason: `Handover question ${questionId} has an unreadable record: Unreadable.`,
    },
  },
  {
    name: 'refuses a question asked from another session',
    given: facts({
      read: {
        kind: 'record',
        record: { ...openRecord(senderSession), askerSession: otherSession },
      },
    }),
    expected: {
      kind: 'refuse',
      reason: `Handover question ${questionId} was asked from another session.`,
    },
  },
  {
    name: 'refuses a question sent to another lead session',
    given: facts({
      read: {
        kind: 'record',
        record: { ...openRecord(senderSession), senderSession: otherSession },
      },
    }),
    expected: {
      kind: 'refuse',
      reason: `Handover question ${questionId} was sent to another lead session.`,
    },
  },
  {
    name: 'refuses a different answer to an answered question',
    given: facts({
      read: { kind: 'record', record: answeredRecord(senderSession, 'Use option B.') },
    }),
    expected: {
      kind: 'refuse',
      reason: `Handover question ${questionId} already has a different answer.`,
    },
  },
  {
    name: 'saves a repeat of the saved answer',
    given: facts({ read: { kind: 'record', record: answeredRecord(senderSession, answer) } }),
    expected: { kind: 'save' },
  },
  {
    name: 'marks an open question answered',
    given: facts(),
    expected: {
      kind: 'markAnswered',
      open: openRecord(senderSession),
      answered: answeredRecord(senderSession, answer),
    },
  },
] as const)('$name', ({ given, expected }) => {
  expect(decideAnswer(given)).toEqual(expected);
});
