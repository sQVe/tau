import type { InputEventResult } from '@earendil-works/pi-coding-agent';

import type { WorkerStart } from './workerResume.js';

export const workerStartMessage = 'Start the assigned work.';

export const workerContinuation =
  'Your session restarted. Finish the assigned work, then call subagent_report.';

export const isStartInput = (pending: boolean, text: string): boolean =>
  pending && text === workerStartMessage;

export const startInputResult = (startText: string | undefined): InputEventResult =>
  startText === undefined ? { action: 'handled' } : { action: 'transform', text: startText };

export const startPromptText = (start: WorkerStart, taskPrompt: string): string | undefined => {
  if (start === 'sendTask') {
    return taskPrompt;
  }

  if (start === 'continue') {
    return workerContinuation;
  }

  return undefined;
};
