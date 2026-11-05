import { readInboxReceipt } from '../../inbox/inbox.js';
import { answerPath, parseAnswerReference, readAnswer } from './answerRecord.js';
import type { AnswerReference } from './answerRecord.js';
import type { Assignment } from './assignment.js';
import { decideWorkerAnswer } from './workerAnswerDecision.js';
import type { DeliveredMessage, OpenQuestion } from './workerAnswerDecision.js';

type QuestionAssignment = Pick<Assignment, 'assignmentId' | 'questions'>;

interface CustomMessageFact {
  customType: string;
  content: unknown;
  details?: unknown;
}

export interface AnswerDelivery {
  assignment: QuestionAssignment;
  sessionId: string;
  message: CustomMessageFact;
}

const readOpenQuestion = async (
  assignment: QuestionAssignment,
): Promise<OpenQuestion | undefined> => {
  const question = assignment.questions.at(-1);

  if (question === undefined) {
    return undefined;
  }

  const answer = await readAnswer(assignment.assignmentId, question.questionId);

  return { questionId: question.questionId, askedAt: question.askedAt, answer };
};

const parseReference = (content: unknown): AnswerReference | undefined => {
  if (typeof content !== 'string') {
    return undefined;
  }

  try {
    return parseAnswerReference(content);
  } catch {
    return undefined;
  }
};

const readDeliveredMessage = (delivery: AnswerDelivery): DeliveredMessage => ({
  workerSessionId: delivery.sessionId,
  receipt: readInboxReceipt({
    type: 'custom_message',
    customType: delivery.message.customType,
    details: delivery.message.details,
  }),
  reference: parseReference(delivery.message.content),
});

export const answersOpenQuestion = async (delivery: AnswerDelivery): Promise<boolean> => {
  const decision = decideWorkerAnswer({
    assignmentId: delivery.assignment.assignmentId,
    question: await readOpenQuestion(delivery.assignment),
    message: readDeliveredMessage(delivery),
  });

  return decision === 'answered';
};

export const readSavedAnswer = async (
  assignment: QuestionAssignment,
): Promise<string | undefined> => {
  const question = await readOpenQuestion(assignment);

  const decision = decideWorkerAnswer({
    assignmentId: assignment.assignmentId,
    question,
    message: undefined,
  });

  return decision === 'answered' && question !== undefined
    ? answerPath(assignment.assignmentId, question.questionId)
    : undefined;
};
