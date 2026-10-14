import type { StartupFailure } from './types.js';

export type StartupEvidence =
  | { status: 'missing' }
  | { status: 'newer' }
  | { status: 'malformed' }
  | { status: 'current'; failure: StartupFailure };

const restartNotice =
  'Tau was updated on disk after this session loaded it, so the worker refused the task. Restart this session to launch workers.';

export const startupFailureAdvice = (evidence: StartupEvidence): string => {
  if (evidence.status === 'missing') {
    return '';
  }

  if (evidence.status === 'newer') {
    return "The worker's error was saved by a newer Tau; restart this session to read it.";
  }

  if (evidence.status === 'malformed') {
    return "The worker's saved error is unreadable.";
  }

  const cause = `Worker error: ${evidence.failure.message}`;

  if (evidence.failure.kind === 'taskRetired') {
    return `${restartNotice} ${cause}`;
  }

  return cause;
};
