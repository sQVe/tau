export type StartTicketMarker = 'unused' | 'started';

export type StartTicketTerminal = 'live' | 'ended' | 'unread' | 'none';

export interface SweepFacts {
  marker: StartTicketMarker;
  terminal: StartTicketTerminal;
}

export type SweepAction = 'cancel' | 'deleteMarker' | 'refuse';

// A started marker proves the child took the ticket, not that Pi made a terminal. Only a terminal
// seen to end proves no Pi can still run, so an unknown or absent terminal refuses.
export const sweepAction = (facts: SweepFacts): SweepAction => {
  if (facts.marker === 'unused') {
    return 'cancel';
  }

  return facts.terminal === 'ended' ? 'deleteMarker' : 'refuse';
};
