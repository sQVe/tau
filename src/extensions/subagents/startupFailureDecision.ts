import type { StartupFailure } from './types.js';

export type StartupEvidence =
  | { status: 'missing' }
  | { status: 'newer' }
  | { status: 'malformed' }
  | { status: 'current'; failure: StartupFailure };

export interface StartupFailureOutcome {
  notice: 'restart' | 'newerRecord' | 'unreadableRecord' | undefined;
  workerError: string | undefined;
}

export const decideStartupFailure = (evidence: StartupEvidence): StartupFailureOutcome => {
  if (evidence.status === 'missing') {
    return { notice: undefined, workerError: undefined };
  }

  if (evidence.status === 'newer') {
    return { notice: 'newerRecord', workerError: undefined };
  }

  if (evidence.status === 'malformed') {
    return { notice: 'unreadableRecord', workerError: undefined };
  }

  const notice = evidence.failure.kind === 'taskRetired' ? 'restart' : undefined;

  return { notice, workerError: evidence.failure.message };
};
