import type { InputEventResult } from '@earendil-works/pi-coding-agent';

import type { WorkerStart } from './workerResume.js';

export const workerStartMessage = 'Start the assigned work.';

export const workerContinuation =
  'Your session restarted. Finish the assigned work, then call subagent_report.';

export const isStartInput = (pending: boolean, text: string): boolean =>
  pending && text === workerStartMessage;

export const startInputResult = (startText: string | undefined): InputEventResult =>
  startText === undefined ? { action: 'handled' } : { action: 'transform', text: startText };

const answeredContinuation = (answerPath: string): string =>
  `Your session restarted. The parent answered your question in ${answerPath}. Read that file, finish the assigned work, then call subagent_report.`;

export const startPromptText = (
  start: WorkerStart,
  taskPrompt: string,
  answerPath: string | undefined,
): string | undefined => {
  if (start === 'sendTask') {
    return taskPrompt;
  }

  if (start !== 'continue') {
    return undefined;
  }

  return answerPath === undefined ? workerContinuation : answeredContinuation(answerPath);
};
