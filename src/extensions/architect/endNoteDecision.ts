export type FinalHandoverState = 'none' | 'unknown' | 'queued';

export type ArchitectRecordFact =
  | { kind: 'read'; sessionFile: string | null; updatedAt: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

export interface EndNoteFacts {
  mode: 'visible' | 'ask';
  leadTerminal: string | null;
  architectTerminal: string | null;
  finalHandover: FinalHandoverState;
  record: ArchitectRecordFact;
}

export type EndNoteDecision = { kind: 'none' } | { kind: 'send'; target: string; text: string };

export const nextFinalHandoverState = (
  current: FinalHandoverState,
  status: 'queued' | 'unknown' | undefined,
): FinalHandoverState => {
  if (current === 'queued' || status === 'queued') {
    return 'queued';
  }

  return status === 'unknown' && current === 'none' ? 'unknown' : current;
};

const recordLine = (record: ArchitectRecordFact): string => {
  if (record.kind === 'read') {
    return `Its record shows session file ${record.sessionFile ?? 'none'}, updated at ${record.updatedAt}.`;
  }

  if (record.kind === 'missing') {
    return 'Its record is missing.';
  }

  return `Its record could not be read: ${record.reason}.`;
};

const endText = (facts: EndNoteFacts, terminal: string): string => {
  const line = recordLine(facts.record);

  if (facts.finalHandover === 'unknown') {
    return `Your architect in terminal ${terminal} ended after a final handover send returned unknown, so it may not have reached you. If no final handover arrived, decide what to do next: call architect open to resume that session, or ask the user. ${line}`;
  }

  return `Your architect in terminal ${terminal} ended without a final handover. ${line} Decide what to do next: call architect open to resume that session, or ask the user.`;
};

export const decideEndNote = (facts: EndNoteFacts): EndNoteDecision => {
  if (facts.mode === 'ask' || facts.finalHandover === 'queued') {
    return { kind: 'none' };
  }

  if (facts.leadTerminal === null || facts.leadTerminal === '') {
    return { kind: 'none' };
  }

  const terminal = facts.architectTerminal ?? 'unknown';

  return { kind: 'send', target: facts.leadTerminal, text: endText(facts, terminal) };
};
