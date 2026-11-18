import type { ArchitectOwner, AskStatus } from '../record.js';

export interface AskOutcomeFacts {
  status: AskStatus;
  ended: boolean;
  exitCode: number | null;
}

export type AskOutcome = 'answered' | 'needsOpen' | 'failed';

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
