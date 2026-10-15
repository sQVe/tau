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

const noticeText = {
  restart:
    'Tau was updated on disk after this session loaded it, so the worker refused the task. Restart this session to launch workers.',
  newerRecord: "The worker's error was saved by a newer Tau; restart this session to read it.",
  unreadableRecord: "The worker's saved error is unreadable.",
};

export const renderStartupFailure = (outcome: StartupFailureOutcome): string => {
  const parts: string[] = [];

  if (outcome.notice !== undefined) {
    parts.push(noticeText[outcome.notice]);
  }

  if (outcome.workerError !== undefined) {
    parts.push(`Worker error: ${outcome.workerError}`);
  }

  return parts.join(' ');
};
