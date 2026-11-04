import type { Assignment } from './assignment.js';
import { workerPrompt } from './profiles.js';
import type { WorkerStart } from './workerResume.js';

export const workerContinuation =
  'Your session restarted. Finish the assigned work, then call subagent_report.';

export const startPromptText = (start: WorkerStart, assignment: Assignment): string | undefined => {
  if (start === 'sendTask') {
    return workerPrompt(assignment);
  }

  if (start === 'continue') {
    return workerContinuation;
  }

  return undefined;
};
