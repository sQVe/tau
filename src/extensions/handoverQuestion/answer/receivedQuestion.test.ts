import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { inboxMessageType, messageText } from '../../../inbox/receiptDecision.js';
import type { ReceivedQuestion } from './receivedQuestion.js';
import { receivedQuestion } from './receivedQuestion.js';

interface QuestionEntryOptions {
  receiptFamily?: 'handover-question' | 'handover' | 'handover-answer';
  receiptQuestionId?: string;
  receiptSessionId?: string;
  headingQuestionId?: string;
  headingAskerTerminal?: string;
  headingAskerSession?: string;
  content?: unknown;
}

const questionId = '11111111-1111-4111-8111-111111111111';
const otherQuestionId = '44444444-4444-4444-8444-444444444444';
const leadSession = '22222222-2222-4222-8222-222222222222';
const otherSession = '33333333-3333-4333-8333-333333333333';
const askerTerminal = 'worker-1';
const askerSession = '55555555-5555-4555-8555-555555555555';
const otherAskerSession = '66666666-6666-4666-8666-666666666666';
const questionText = 'Which option should I use?';

const headingText = (
  headingQuestionId: string,
  terminal = askerTerminal,
  session = askerSession,
): string =>
  messageText({
    family: 'handover-question',
    payload: {
      questionId: headingQuestionId,
      text: questionText,
      askerTerminal: terminal,
      askerSession: session,
    },
  });

const questionEntry = (options: QuestionEntryOptions = {}): SessionEntry => {
  const family = options.receiptFamily ?? 'handover-question';
  const receiptQuestionId = options.receiptQuestionId ?? questionId;
  const sessionId = options.receiptSessionId ?? leadSession;

  const content =
    options.content ??
    headingText(
      options.headingQuestionId ?? questionId,
      options.headingAskerTerminal,
      options.headingAskerSession,
    );

  const details =
    family === 'handover'
      ? { version: 4, messageId: questionId, sessionId, family }
      : { version: 4, messageId: questionId, sessionId, family, questionId: receiptQuestionId };

  return {
    type: 'custom_message',
    customType: inboxMessageType,
    content,
    display: true,
    details,
  } as unknown as SessionEntry;
};

const userEntry = (): SessionEntry =>
  ({
    type: 'message',
    message: { role: 'user', content: 'Do the work.' },
  }) as unknown as SessionEntry;

// The heading stays literal because version 3 receipts keep the base layout.
const frozenVersion3Entry = (): SessionEntry =>
  ({
    type: 'custom_message',
    customType: inboxMessageType,
    content: `Handover question ${questionId} from terminal ${askerTerminal}, session ${askerSession}:\n\n${questionText}`,
    display: true,
    details: {
      version: 3,
      messageId: questionId,
      sessionId: leadSession,
      family: 'handover-question',
      questionId,
    },
  }) as unknown as SessionEntry;

const asker: ReceivedQuestion = { askerTerminal, askerSession };

const cases: readonly {
  name: string;
  entries: readonly SessionEntry[];
  expected: ReceivedQuestion | undefined;
}[] = [
  {
    name: 'the question this lead session received',
    entries: [questionEntry()],
    expected: asker,
  },
  {
    name: 'a frozen version 3 question receipt',
    entries: [frozenVersion3Entry()],
    expected: asker,
  },
  {
    name: 'two receipts naming the same asker',
    entries: [questionEntry(), questionEntry()],
    expected: asker,
  },
  {
    name: 'an entry without a receipt before the question',
    entries: [userEntry(), questionEntry()],
    expected: asker,
  },
  {
    name: 'a handover-answer receipt naming the same question',
    entries: [questionEntry({ receiptFamily: 'handover-answer' })],
    expected: undefined,
  },
  {
    name: 'another question ID',
    entries: [
      questionEntry({ receiptQuestionId: otherQuestionId, headingQuestionId: otherQuestionId }),
    ],
    expected: undefined,
  },
  {
    name: 'a handover receipt',
    entries: [questionEntry({ receiptFamily: 'handover' })],
    expected: undefined,
  },
  {
    name: 'a receipt from another session',
    entries: [questionEntry({ receiptSessionId: otherSession })],
    expected: undefined,
  },
  {
    name: 'a receipt with another question ID and the requested heading',
    entries: [questionEntry({ receiptQuestionId: otherQuestionId })],
    expected: undefined,
  },
  {
    name: 'two receipts naming different asker terminals',
    entries: [questionEntry(), questionEntry({ headingAskerTerminal: 'worker-2' })],
    expected: undefined,
  },
  {
    name: 'two receipts on one terminal naming different asker sessions',
    entries: [questionEntry(), questionEntry({ headingAskerSession: otherAskerSession })],
    expected: undefined,
  },
  {
    name: 'a heading with a non-UUID question ID',
    entries: [
      questionEntry({
        content: `Handover question not-a-uuid from terminal ${askerTerminal}, session ${askerSession}:\n\n${questionText}`,
      }),
    ],
    expected: undefined,
  },
  {
    name: 'a heading with a mismatched question ID',
    entries: [questionEntry({ headingQuestionId: otherQuestionId })],
    expected: undefined,
  },
  {
    name: 'block content',
    entries: [questionEntry({ content: [{ type: 'text', text: headingText(questionId) }] })],
    expected: undefined,
  },
];

it.each(cases.map((row) => [row.name, row] as const))('decides %s', (_name, row) => {
  expect(receivedQuestion(row.entries, questionId, leadSession)).toEqual(row.expected);
});
