export type SessionUse = 'free' | 'inUse' | 'unknown';

export type SessionUseAssignment =
  | { kind: 'none' }
  | { kind: 'unread' }
  | { kind: 'missing' }
  | { kind: 'malformed' }
  | { kind: 'saved'; sessionFile: string };

export interface SessionUseTerminal {
  state: string;
  assignmentLabel: string | undefined;
  assignment: SessionUseAssignment;
}

export interface SessionUseFacts {
  sourceSessionFile: string;
  terminals: readonly SessionUseTerminal[];
}

// A finished terminal no longer holds its session, so only running terminals decide. A running
// terminal with the assignment label but an unreadable assignment could be the source's worker, so
// it is unknown rather than free.
export const decideSessionUse = (facts: SessionUseFacts): SessionUse => {
  let unknown = false;

  for (const terminal of facts.terminals) {
    if (terminal.state === 'finished') {
      continue;
    }

    const { assignment } = terminal;

    if (assignment.kind === 'saved') {
      const usesSource =
        terminal.assignmentLabel !== undefined &&
        assignment.sessionFile === facts.sourceSessionFile;

      if (usesSource) {
        return 'inUse';
      }

      continue;
    }

    if (assignment.kind === 'unread' || assignment.kind === 'malformed') {
      unknown = true;

      continue;
    }

    if (assignment.kind === 'missing' && terminal.assignmentLabel !== undefined) {
      unknown = true;
    }
  }

  return unknown ? 'unknown' : 'free';
};
