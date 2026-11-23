type FinalHandoverState = 'none' | 'unknown' | 'queued';

export interface EndNoteRoute {
  leadTerminal: string;
  architectTerminal: string | null;
  finalHandover: FinalHandoverState;
}

export type ArchitectRecordFact =
  | { kind: 'read'; sessionFile: string | null; updatedAt: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

export type EndNoteSelection =
  | { kind: 'none' }
  | {
      kind: 'send';
      target: string;
      architectTerminal: string | null;
      finalHandover: FinalHandoverState;
    };

export type EndNoteDecision = { kind: 'none' } | { kind: 'send'; target: string; text: string };

export const nextEndNoteRoute = (
  route: EndNoteRoute | undefined,
  status: 'queued' | 'unknown',
): EndNoteRoute | undefined => {
  if (route === undefined || route.finalHandover === 'queued' || status === 'queued') {
    return undefined;
  }

  const finalHandover = route.finalHandover === 'none' ? 'unknown' : route.finalHandover;

  return { ...route, finalHandover };
};

export const selectEndNote = (route: EndNoteRoute | undefined): EndNoteSelection => {
  if (route === undefined || route.finalHandover === 'queued') {
    return { kind: 'none' };
  }

  return {
    kind: 'send',
    target: route.leadTerminal,
    architectTerminal: route.architectTerminal,
    finalHandover: route.finalHandover,
  };
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

const endText = (
  selection: Extract<EndNoteSelection, { kind: 'send' }>,
  record: ArchitectRecordFact,
): string => {
  const line = recordLine(record);
  const terminal = selection.architectTerminal ?? 'unknown';

  if (selection.finalHandover === 'unknown') {
    return `Your architect in terminal ${terminal} ended after a final handover send returned unknown, so it may not have reached you. If no final handover arrived, decide what to do next: call architect open to resume that session, or ask the user. ${line}`;
  }

  return `Your architect in terminal ${terminal} ended without a final handover. ${line} Decide what to do next: call architect open to resume that session, or ask the user.`;
};

export const decideEndNote = (
  selection: EndNoteSelection,
  record: ArchitectRecordFact,
): EndNoteDecision => {
  if (selection.kind === 'none') {
    return selection;
  }

  return { kind: 'send', target: selection.target, text: endText(selection, record) };
};
