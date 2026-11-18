import type { AskStatus } from './record.js';

export interface AskOutcomeFacts {
  status: AskStatus;
  ended: boolean;
  exitCode: number | null;
}

export type AskOutcome = 'answered' | 'needsOpen' | 'failed';

export interface AskRouteFacts {
  root: string;
  holderCheckout: string | undefined;
  architectTerminal: string | null;
  sessionFile: string | null;
}

export type AskRoute =
  | { kind: 'hidden'; sessionFile: string }
  | { kind: 'live'; terminal: string }
  | { kind: 'needsOpen'; reason: string };

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

// A live architect in this checkout takes the question in its inbox, so no second Pi process
// writes its session file. Without a live holder, the ask resumes the recorded session in a hidden
// terminal. A live architect that has not recorded its terminal yet holds the lock before it
// writes the record, so the lead asks again instead of calling open, which the lock would refuse.
export const askRoute = (facts: AskRouteFacts): AskRoute => {
  if (facts.holderCheckout !== undefined && facts.holderCheckout !== facts.root) {
    return {
      kind: 'needsOpen',
      reason: `The architect is already running in ${facts.holderCheckout}. Call architect open to talk to it.`,
    };
  }

  if (facts.holderCheckout === facts.root) {
    if (facts.architectTerminal === null) {
      return { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' };
    }

    return { kind: 'live', terminal: facts.architectTerminal };
  }

  if (facts.sessionFile === null) {
    return {
      kind: 'needsOpen',
      reason: 'No architect session is recorded for this checkout. Call architect open first.',
    };
  }

  return { kind: 'hidden', sessionFile: facts.sessionFile };
};
