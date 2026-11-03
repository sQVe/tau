import type { SessionEntry } from '@earendil-works/pi-coding-agent';

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

const waitsAfterQuestion = (branch: readonly SessionEntry[], questionIndex: number): boolean =>
  !branch.slice(questionIndex + 1).some(isUserMessage);

const isFirstAssignmentSentByMessage = (
  branch: readonly SessionEntry[],
  previousAssignmentId: string | null,
): boolean => previousAssignmentId === null && branch.some(isUserMessage);

export const decideWorkerResume = (
  branch: readonly SessionEntry[],
  assignment: Pick<Assignment, 'assignmentId' | 'previousAssignmentId'>,
): WorkerResume => {
  const questionIndex = branch.findLastIndex(isQuestionResult);
  const taskSent = branch.some((entry) => namesAssignment(entry, assignment.assignmentId));

  const firstSentByMessage = isFirstAssignmentSentByMessage(
    branch,
    assignment.previousAssignmentId,
  );

  return {
    sendTaskPrompt: !taskSent && !firstSentByMessage,
    waitingForQuestion: questionIndex !== -1 && waitsAfterQuestion(branch, questionIndex),
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
