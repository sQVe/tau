import type { SessionEntry } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../../schema.js';

export interface WorkerResume {
  sendTaskPrompt: boolean;
  waitingForQuestion: boolean;
}

const messageRecord = (entry: SessionEntry): Record<string, unknown> | undefined => {
  if (entry.type !== 'message') {
    return undefined;
  }

  const message: unknown = entry.message;

  return isRecord(message) ? message : undefined;
};

const isUserMessage = (entry: SessionEntry): boolean => messageRecord(entry)?.role === 'user';

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

// A reloaded session replays its branch, so the saved entries decide the resume: no user message
// means the task prompt never went out, and a question with no later user message means an answer
// is still pending.
export const decideWorkerResume = (branch: readonly SessionEntry[]): WorkerResume => {
  const questionIndex = branch.findLastIndex(isQuestionResult);

  return {
    sendTaskPrompt: !branch.some(isUserMessage),
    waitingForQuestion: questionIndex !== -1 && waitsAfterQuestion(branch, questionIndex),
  };
};
