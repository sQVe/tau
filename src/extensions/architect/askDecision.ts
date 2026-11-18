import type { ArchitectOwner, AskStatus } from './record.js';

export interface AskOutcomeFacts {
  status: AskStatus;
  ended: boolean;
  exitCode: number | null;
}

export type AskOutcome = 'answered' | 'needsOpen' | 'failed';

export interface AskRouteFacts {
  root: string;
  holder: { checkout: string; token: string } | undefined;
  owner: ArchitectOwner | null;
  sessionFile: string | null;
}

export type AskRoute =
  | { kind: 'hidden'; sessionFile: string }
  | { kind: 'live'; terminal: string; sessionId: string }
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

// A live architect in this checkout takes the question in its inbox only while its recorded lock
// token matches the holder. A recorded route without the lock is still starting, so the lead asks
// again instead of calling open, which the lock would refuse. A hidden ask holds the lock too, and
// a second question would reach a session that answers only the first. Without a live holder, the
// ask resumes the recorded session in a hidden terminal.
export const askRoute = (facts: AskRouteFacts): AskRoute => {
  if (facts.holder !== undefined && facts.holder.checkout !== facts.root) {
    return {
      kind: 'needsOpen',
      reason: `The architect is already running in ${facts.holder.checkout}. Call architect open to talk to it.`,
    };
  }

  if (facts.holder !== undefined) {
    const { owner } = facts;
    const ownsLock = owner !== null && owner.lockToken === facts.holder.token;

    if (!ownsLock) {
      return { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' };
    }

    if (owner.mode === 'ask') {
      return { kind: 'needsOpen', reason: 'A hidden ask is running. Wait for its answer.' };
    }

    if (owner.terminal === null) {
      return {
        kind: 'needsOpen',
        reason: 'The live architect runs outside an hc terminal. Switch to its pane to talk to it.',
      };
    }

    return { kind: 'live', terminal: owner.terminal, sessionId: owner.sessionId };
  }

  if (facts.sessionFile === null) {
    return {
      kind: 'needsOpen',
      reason: 'No architect session is recorded for this checkout. Call architect open first.',
    };
  }

  return { kind: 'hidden', sessionFile: facts.sessionFile };
};
