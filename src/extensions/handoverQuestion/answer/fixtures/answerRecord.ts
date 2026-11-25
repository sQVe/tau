import type { QuestionRecord } from '../../question/questionRecord.js';

const questionId = '11111111-1111-4111-8111-111111111111';

const recordFields = {
  version: 1 as const,
  questionId,
  askerTerminal: 'worker-1',
  askerSession: '22222222-2222-4222-8222-222222222222',
  senderTerminal: 'lead-1',
  text: 'Which option should I use?',
  askedAt: '2026-11-18T12:00:00.000Z',
};

export const openRecord = (senderSession: string): QuestionRecord => ({
  ...recordFields,
  senderSession,
  state: 'open',
  answer: null,
});

export const answeredRecord = (senderSession: string, answer: string): QuestionRecord => ({
  ...recordFields,
  senderSession,
  state: 'answered',
  answer,
});
