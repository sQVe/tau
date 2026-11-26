import type { QuestionRead, QuestionRecord } from '../question/questionRecord.js';

interface AnswerPayload {
  questionId: string;
  senderSession: string;
  answer: string;
}

export interface AnswerFacts {
  messageId: string;
  targetSessionId: string;
  payload: AnswerPayload;
  read: QuestionRead;
}

export type AnswerDecision =
  | { kind: 'refuse'; reason: string }
  | { kind: 'save' }
  | { kind: 'markAnswered'; open: QuestionRecord; answered: QuestionRecord };

export const decideAnswer = (facts: AnswerFacts): AnswerDecision => {
  const { messageId, targetSessionId, payload, read } = facts;

  if (messageId !== payload.questionId) {
    return {
      kind: 'refuse',
      reason: 'A handover answer must use its question ID as its message ID.',
    };
  }

  if (read.kind === 'missing') {
    return {
      kind: 'refuse',
      reason: `This session asked no handover question ${payload.questionId}.`,
    };
  }

  if (read.kind === 'malformed') {
    return {
      kind: 'refuse',
      reason: `Handover question ${payload.questionId} has an unreadable record: ${read.reason}`,
    };
  }

  const { record } = read;

  if (record.askerSession !== targetSessionId) {
    return {
      kind: 'refuse',
      reason: `Handover question ${payload.questionId} was asked from another session.`,
    };
  }

  if (record.senderSession !== payload.senderSession) {
    return {
      kind: 'refuse',
      reason: `Handover question ${payload.questionId} was sent to another lead session.`,
    };
  }

  if (record.state === 'answered') {
    if (record.answer !== payload.answer) {
      return {
        kind: 'refuse',
        reason: `Handover question ${payload.questionId} already has a different answer.`,
      };
    }

    return { kind: 'save' };
  }

  const answered: QuestionRecord = { ...record, state: 'answered', answer: payload.answer };

  return { kind: 'markAnswered', open: record, answered };
};
