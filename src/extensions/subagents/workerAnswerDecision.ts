import type { InboxReceipt } from '../../inbox/inbox.js';
import type { AnswerRead, AnswerReference } from './answerRecord.js';
import type { SavedQuestion } from './assignment.js';

export interface OpenQuestion extends Pick<SavedQuestion, 'questionId' | 'askedAt'> {
  answer: AnswerRead;
}

export interface DeliveredMessage {
  workerSessionId: string;
  receipt: InboxReceipt | undefined;
  reference: AnswerReference | undefined;
}

export interface WorkerAnswerFacts {
  assignmentId: string;
  question: OpenQuestion | undefined;
  // A resumed worker has no delivered message; only its saved answer file counts.
  message: DeliveredMessage | undefined;
}

export type WorkerAnswerDecision =
  | 'answered'
  | 'noQuestion'
  | 'otherFamily'
  | 'otherSession'
  | 'malformedReference'
  | 'otherAssignment'
  | 'otherQuestion'
  | 'unanswered'
  | 'refusedAnswer'
  | 'olderAnswer';

const messageProblem = (
  assignmentId: string,
  question: OpenQuestion,
  message: DeliveredMessage,
): WorkerAnswerDecision | undefined => {
  if (message.receipt?.family !== 'answer') {
    return 'otherFamily';
  }

  if (message.receipt.sessionId !== message.workerSessionId) {
    return 'otherSession';
  }

  if (message.reference === undefined) {
    return 'malformedReference';
  }

  if (message.reference.assignmentId !== assignmentId) {
    return 'otherAssignment';
  }

  if (message.reference.questionId !== question.questionId) {
    return 'otherQuestion';
  }

  return undefined;
};

const answerProblem = (question: OpenQuestion): WorkerAnswerDecision | undefined => {
  const { answer } = question;

  if (answer.kind === 'unanswered') {
    return 'unanswered';
  }

  if (answer.kind === 'refused') {
    return 'refusedAnswer';
  }

  if (answer.record.answeredAt < question.askedAt) {
    return 'olderAnswer';
  }

  return undefined;
};

export const decideWorkerAnswer = (facts: WorkerAnswerFacts): WorkerAnswerDecision => {
  const { question, message } = facts;

  if (question === undefined) {
    return 'noQuestion';
  }

  const problem =
    message === undefined ? undefined : messageProblem(facts.assignmentId, question, message);

  return problem ?? answerProblem(question) ?? 'answered';
};
