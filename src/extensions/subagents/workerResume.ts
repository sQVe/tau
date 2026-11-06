import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import { inboxMessageType } from '../../inbox/receiptDecision.js';
import { isRecord } from '../../schema.js';
import type { Assignment } from './assignment.js';
import { taskPromptHeader } from './workerMessage.js';

export interface WorkerResume {
  sendTaskPrompt: boolean;
  waitingForQuestion: boolean;
}

export type WorkerStart = 'shutdown' | 'sendTask' | 'wait' | 'continue';

const messageRecord = (entry: SessionEntry): Record<string, unknown> | undefined => {
  if (entry.type !== 'message') {
    return undefined;
  }

  const message: unknown = entry.message;

  return isRecord(message) ? message : undefined;
};

const isUserMessage = (entry: SessionEntry): boolean => messageRecord(entry)?.role === 'user';

const messageText = (entry: SessionEntry): string | undefined => {
  const message = messageRecord(entry);

  if (message?.role !== 'user') {
    return undefined;
  }

  const content = message['content'];

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const texts: string[] = [];

  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      texts.push(block['text']);
    }
  }

  return texts.join('\n');
};

const namesAssignment = (entry: SessionEntry, assignmentId: string): boolean => {
  const text = messageText(entry);

  return text?.split('\n').includes(taskPromptHeader(assignmentId)) === true;
};

const isQuestionResult = (entry: SessionEntry): boolean => {
  const message = messageRecord(entry);

  return (
    message?.role === 'toolResult' &&
    message.toolName === 'subagent_question' &&
    message.isError !== true
  );
};

// Returns the question an inbox answer message answers, for a session entry or a started message.
export const answeredQuestionId = (message: {
  customType?: string;
  details?: unknown;
}): string | undefined => {
  if (message.customType !== inboxMessageType || !isRecord(message.details)) {
    return undefined;
  }

  const { family, questionId } = message.details;

  return family === 'answer' && typeof questionId === 'string' ? questionId : undefined;
};

const answers = (entry: SessionEntry, questionId: string | undefined): boolean =>
  entry.type === 'custom_message' &&
  questionId !== undefined &&
  answeredQuestionId(entry) === questionId;

const waitsAfterQuestion = (
  branch: readonly SessionEntry[],
  questionIndex: number,
  questionId: string | undefined,
): boolean =>
  !branch
    .slice(questionIndex + 1)
    .some((entry) => isUserMessage(entry) || answers(entry, questionId));

const isFirstAssignmentSentByMessage = (
  branch: readonly SessionEntry[],
  previousAssignmentId: string | null,
): boolean => previousAssignmentId === null && branch.some(isUserMessage);

export const decideWorkerResume = (
  branch: readonly SessionEntry[],
  assignment: Pick<Assignment, 'assignmentId' | 'previousAssignmentId' | 'questions'>,
): WorkerResume => {
  const questionIndex = branch.findLastIndex(isQuestionResult);
  const openQuestionId = assignment.questions.at(-1)?.questionId;
  const taskSent = branch.some((entry) => namesAssignment(entry, assignment.assignmentId));

  const firstSentByMessage = isFirstAssignmentSentByMessage(
    branch,
    assignment.previousAssignmentId,
  );

  return {
    sendTaskPrompt: !taskSent && !firstSentByMessage,
    waitingForQuestion:
      questionIndex !== -1 && waitsAfterQuestion(branch, questionIndex, openQuestionId),
  };
};

export const decideWorkerStart = (resume: WorkerResume, hasReport: boolean): WorkerStart => {
  if (hasReport) {
    return 'shutdown';
  }

  if (resume.sendTaskPrompt) {
    return 'sendTask';
  }

  if (resume.waitingForQuestion) {
    return 'wait';
  }

  return 'continue';
};
