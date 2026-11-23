export type StartTicketChild = 'running' | 'gone' | 'unknown';

export type SweepFacts =
  | { kind: 'unused' }
  | { kind: 'malformed'; path: string }
  | { kind: 'started'; path: string; processId: number; child: StartTicketChild };

export type SweepAction =
  | { kind: 'cancel' }
  | { kind: 'deleteMarker'; path: string }
  | { kind: 'refuseRunning'; processId: number }
  | { kind: 'refuseMalformed'; path: string };

// A started marker proves the child took the ticket, not that Pi made a terminal. Only the kernel's
// answer that the child is gone proves no Pi can still run.
export const sweepAction = (facts: SweepFacts): SweepAction => {
  if (facts.kind === 'unused') {
    return { kind: 'cancel' };
  }

  if (facts.kind === 'malformed') {
    return { kind: 'refuseMalformed', path: facts.path };
  }

  return facts.child === 'gone'
    ? { kind: 'deleteMarker', path: facts.path }
    : { kind: 'refuseRunning', processId: facts.processId };
};
