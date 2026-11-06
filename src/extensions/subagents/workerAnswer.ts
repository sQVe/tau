import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import type { MessageRequest } from '../../inbox/inbox.js';
import { answeredQuestionId } from '../../inbox/receiptDecision.js';
import type { Assignment } from './assignment.js';

export type AnswerAssignment = Pick<
  Assignment,
  'assignmentId' | 'parentSession' | 'questions' | 'report'
>;

export interface WorkerAnswerFacts {
  assignment: AnswerAssignment | undefined;
  request: Extract<MessageRequest, { family: 'answer' }>;
  branch: readonly SessionEntry[];
}

const differsFromShown = (
  branch: readonly SessionEntry[],
  questionId: string,
  answer: string,
): boolean =>
  branch.some(
    (entry) =>
      entry.type === 'custom_message' &&
      answeredQuestionId(entry) === questionId &&
      entry.content !== answer,
  );

// The answer's message ID is its question ID, so a second pending answer to one question is saved
// under the same ID and refused as different content.
export const workerAnswerRefusal = ({
  assignment,
  request,
  branch,
}: WorkerAnswerFacts): string | undefined => {
  const { payload } = request;

  if (assignment === undefined) {
    return 'This worker has no loaded assignment.';
  }

  if (payload.assignmentId !== assignment.assignmentId) {
    return `This worker runs assignment ${assignment.assignmentId}, not ${payload.assignmentId}.`;
  }

  if (payload.parentSession !== assignment.parentSession) {
    return `Assignment ${assignment.assignmentId} belongs to another manager.`;
  }

  if (assignment.report !== null) {
    return `Assignment ${assignment.assignmentId} already has a report.`;
  }

  if (assignment.questions.at(-1)?.questionId !== payload.questionId) {
    return `Question ${payload.questionId} is not the open question of assignment ${assignment.assignmentId}.`;
  }

  if (request.messageId !== payload.questionId) {
    return `An answer to question ${payload.questionId} must use the question ID as its message ID.`;
  }

  if (differsFromShown(branch, payload.questionId, payload.answer)) {
    return `Question ${payload.questionId} already has another answer.`;
  }

  return undefined;
};
