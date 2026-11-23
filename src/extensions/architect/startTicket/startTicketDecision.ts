export type StartTicketMarker = 'unused' | 'started' | 'malformed';

type StartTicketChild = 'running' | 'gone' | 'unknown';

export interface SweepFacts {
  marker: StartTicketMarker;
  child: StartTicketChild;
}

export type SweepAction = 'cancel' | 'deleteMarker' | 'refuseRunning' | 'refuseMalformed';

// A started marker proves the child took the ticket, not that Pi made a terminal. Only the kernel's
// answer that the child is gone proves no Pi can still run.
export const sweepAction = (facts: SweepFacts): SweepAction => {
  if (facts.marker === 'unused') {
    return 'cancel';
  }

  if (facts.marker === 'malformed') {
    return 'refuseMalformed';
  }

  return facts.child === 'gone' ? 'deleteMarker' : 'refuseRunning';
};
