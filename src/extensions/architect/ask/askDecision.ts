import type { ArchitectOwner, AskStatus } from '../record.js';

export interface AskRecordOutcomeFacts {
  status: AskStatus;
  answer: string | null;
}

export type AskRecordOutcome = 'answered' | 'deadline' | 'failed' | 'kept' | 'unreadable';

export type ArchitectPublication =
  | { kind: 'none' }
  | { kind: 'version1'; updatedAt: number }
  | { kind: 'owner'; owner: ArchitectOwner };

export interface AskRouteFacts {
  root: string;
  holder: { checkout: string; token: string; startedAt: number } | undefined;
  publication: ArchitectPublication;
  sessionFile: string | null;
}

export type AskRoute =
  | { kind: 'hidden'; sessionFile: string }
  | { kind: 'live'; terminal: string; sessionId: string; lockToken: string }
  | { kind: 'needsOpen'; reason: string };

export type AskDeadlineAction = 'wait' | 'expire';

export interface AskDeadlineFacts {
  now: number;
  deadline: number;
}

export type StaleAskRepair = 'repair' | 'leave';

export interface StaleAskFacts {
  status: AskStatus;
  terminalState: 'live' | 'ended' | 'unread';
  recordTerminal: string | null;
  endedTerminal: string;
}

export type AskTransition = 'allowed' | 'refused';

// A settled hidden ask is final, so only a running record may change.
export const askTransition = (current: AskStatus): AskTransition =>
  current === 'running' ? 'allowed' : 'refused';

// The locked record decides the result after the wait. A sent answer wins, a deadline is the
// deadline outcome, and only a running record means the claim was kept.
export const askRecordOutcome = (facts: AskRecordOutcomeFacts): AskRecordOutcome => {
  if (facts.status === 'sent') {
    return facts.answer === null ? 'unreadable' : 'answered';
  }

  if (facts.status === 'timeout') {
    return 'deadline';
  }

  if (facts.status === 'failed') {
    return 'failed';
  }

  return 'kept';
};

export const askRoute = (facts: AskRouteFacts): AskRoute => {
  if (facts.holder !== undefined && facts.holder.checkout !== facts.root) {
    return {
      kind: 'needsOpen',
      reason: `The architect is already running in ${facts.holder.checkout}. Call architect open to talk to it.`,
    };
  }

  if (facts.holder !== undefined) {
    const { publication, holder } = facts;

    if (publication.kind === 'version1' && publication.updatedAt >= holder.startedAt) {
      return {
        kind: 'needsOpen',
        reason:
          'The architect in this checkout runs an older Tau version without live asks. Wait until it closes, then call architect ask again. If it runs in a pane, the user can talk to it there.',
      };
    }

    if (publication.kind !== 'owner' || publication.owner.lockToken !== holder.token) {
      return { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' };
    }

    const { owner } = publication;

    if (owner.mode === 'ask') {
      return { kind: 'needsOpen', reason: 'A hidden ask is running. Wait for its answer.' };
    }

    if (owner.terminal === null) {
      return {
        kind: 'needsOpen',
        reason: 'The live architect runs outside an hc terminal. Switch to its pane to talk to it.',
      };
    }

    return {
      kind: 'live',
      terminal: owner.terminal,
      sessionId: owner.sessionId,
      lockToken: owner.lockToken,
    };
  }

  if (facts.sessionFile === null) {
    return {
      kind: 'needsOpen',
      reason: 'No architect session is recorded for this checkout. Call architect open first.',
    };
  }

  return { kind: 'hidden', sessionFile: facts.sessionFile };
};

export const askDeadlineDetail = 'The ask reached its deadline before the architect answered.';

export const askDeadlineAction = (facts: AskDeadlineFacts): AskDeadlineAction =>
  facts.now >= facts.deadline ? 'expire' : 'wait';

export const staleAskRepair = (facts: StaleAskFacts): StaleAskRepair =>
  facts.status === 'running' &&
  facts.terminalState === 'ended' &&
  facts.recordTerminal === facts.endedTerminal
    ? 'repair'
    : 'leave';
