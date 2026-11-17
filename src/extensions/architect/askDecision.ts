import type { AskStatus } from './record.js';

export interface AskOutcomeFacts {
  status: AskStatus;
  ended: boolean;
  exitCode: number | null;
}

export type AskOutcome = 'answered' | 'needsOpen' | 'failed';

// A sent answer is the only answered outcome. A timeout, or an ended ask that never sent, tells
// the lead to open the architect. A terminal that failed on its own is failed.
export const askOutcome = (facts: AskOutcomeFacts): AskOutcome => {
  if (facts.status === 'sent') {
    return 'answered';
  }

  if (facts.status === 'failed') {
    return 'failed';
  }

  if (facts.status === 'timeout') {
    return 'needsOpen';
  }

  if (!facts.ended) {
    return 'needsOpen';
  }

  return facts.exitCode === 0 ? 'needsOpen' : 'failed';
};
