import { expect, it } from 'vitest';

import type { InboxReceipt } from '../../inbox/inbox.js';
import type { AnswerRead, AnswerReference } from './answerRecord.js';
import { decideWorkerAnswer } from './workerAnswerDecision.js';
import type {
  DeliveredMessage,
  OpenQuestion,
  WorkerAnswerDecision,
} from './workerAnswerDecision.js';

const assignmentId = '11111111-1111-4111-8111-111111111111';
const otherAssignmentId = '22222222-2222-4222-8222-222222222222';
const questionId = '33333333-3333-4333-8333-333333333333';
const otherQuestionId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const otherSessionId = '66666666-6666-4666-8666-666666666666';
const askedAt = 1_800_000_000_000;

const answered = (answeredAt = askedAt + 1): AnswerRead => ({
  kind: 'answered',
  record: { version: 1, assignmentId, questionId, answeredAt, answer: 'Use A.' },
});

const question = (answer: AnswerRead = answered()): OpenQuestion => ({
  questionId,
  askedAt,
  answer,
});

const receipt = (overrides: Partial<InboxReceipt> = {}): InboxReceipt => ({
  version: 2,
  messageId: 'message-1',
  sessionId,
  family: 'answer',
  ...overrides,
});

const reference = (overrides: Partial<AnswerReference> = {}): AnswerReference => ({
  assignmentId,
  questionId,
  answerPath: `/agent/assignments/${assignmentId}/answers/${questionId}.json`,
  ...overrides,
});

const message = (overrides: Partial<DeliveredMessage> = {}): DeliveredMessage => ({
  workerSessionId: sessionId,
  receipt: receipt(),
  reference: reference(),
  ...overrides,
});

it.each<{
  name: string;
  question: OpenQuestion | undefined;
  message: DeliveredMessage | undefined;
  expected: WorkerAnswerDecision;
}>([
  {
    name: 'a delivered answer for the open question',
    question: question(),
    message: message(),
    expected: 'answered',
  },
  {
    name: 'a saved answer for the open question at resume',
    question: question(),
    message: undefined,
    expected: 'answered',
  },
  {
    name: 'no open question',
    question: undefined,
    message: message(),
    expected: 'noQuestion',
  },
  {
    name: 'a message that is not from the inbox',
    question: question(),
    message: message({ receipt: undefined }),
    expected: 'otherFamily',
  },
  {
    name: 'a handover',
    question: question(),
    message: message({ receipt: receipt({ family: 'handover' }) }),
    expected: 'otherFamily',
  },
  {
    name: 'an answer for another session',
    question: question(),
    message: message({ receipt: receipt({ sessionId: otherSessionId }) }),
    expected: 'otherSession',
  },
  {
    name: 'an answer whose content is not a reference',
    question: question(),
    message: message({ reference: undefined }),
    expected: 'malformedReference',
  },
  {
    name: 'an answer for a previous assignment',
    question: question(),
    message: message({ reference: reference({ assignmentId: otherAssignmentId }) }),
    expected: 'otherAssignment',
  },
  {
    name: 'an answer for another question',
    question: question(),
    message: message({ reference: reference({ questionId: otherQuestionId }) }),
    expected: 'otherQuestion',
  },
  {
    name: 'no answer file',
    question: question({ kind: 'unanswered' }),
    message: message(),
    expected: 'unanswered',
  },
  {
    name: 'no saved answer at resume',
    question: question({ kind: 'unanswered' }),
    message: undefined,
    expected: 'unanswered',
  },
  {
    name: 'a malformed or newer answer record',
    question: question({ kind: 'refused', reason: 'Malformed answer record.' }),
    message: message(),
    expected: 'refusedAnswer',
  },
  {
    name: 'an answer saved before the question was asked',
    question: question(answered(askedAt - 1)),
    message: message(),
    expected: 'olderAnswer',
  },
  {
    name: 'an answer saved when the question was asked',
    question: question(answered(askedAt)),
    message: message(),
    expected: 'answered',
  },
])('$name', ({ question: open, message: delivered, expected }) => {
  expect(decideWorkerAnswer({ assignmentId, question: open, message: delivered })).toBe(expected);
});
