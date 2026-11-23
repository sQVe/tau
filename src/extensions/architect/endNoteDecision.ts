import type { FinalHandoverResult } from './queuedHandover.js';

type FinalHandoverState = 'none' | 'unknown';

export interface EndNoteRoute {
  leadTerminal: string;
  architectTerminal: string | null;
  finalHandover: FinalHandoverState;
}

export type ArchitectRecordFact =
  | { kind: 'read'; sessionFile: string | null; updatedAt: string }
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string };

export interface EndNote {
  target: string;
  text: string;
}

export interface EndNoteRouteFacts {
  mode: 'visible' | 'ask';
  leadTerminal: string | null;
  architectTerminal: string | null;
}

export const initialEndNoteRoute = (facts: EndNoteRouteFacts): EndNoteRoute | undefined => {
  if (facts.mode !== 'visible') {
    return undefined;
  }

  if (facts.leadTerminal === null || facts.leadTerminal === '') {
    return undefined;
  }

  return {
    leadTerminal: facts.leadTerminal,
    architectTerminal: facts.architectTerminal,
    finalHandover: 'none',
  };
};

export const nextEndNoteRoute = (
  route: EndNoteRoute | undefined,
  result: FinalHandoverResult,
): EndNoteRoute | undefined => {
  if (route === undefined) {
    return undefined;
  }

  if (result.terminal !== route.leadTerminal) {
    return route;
  }

  if (result.status === 'queued') {
    return undefined;
  }

  return { ...route, finalHandover: 'unknown' };
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

const endText = (route: EndNoteRoute, record: ArchitectRecordFact): string => {
  const line = recordLine(record);
  const terminal = route.architectTerminal ?? 'unknown';

  if (route.finalHandover === 'unknown') {
    return `Your architect in terminal ${terminal} ended after a final handover send returned unknown, so it may not have reached you. If no final handover arrived, decide what to do next: call architect open to resume that session, or ask the user. ${line}`;
  }

  return `Your architect in terminal ${terminal} ended without a final handover. ${line} Decide what to do next: call architect open to resume that session, or ask the user.`;
};

export const decideEndNote = (route: EndNoteRoute, record: ArchitectRecordFact): EndNote => ({
  target: route.leadTerminal,
  text: endText(route, record),
});
