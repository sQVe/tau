import type { ProcessState } from '../../../process/process.js';

export type SweepFacts =
  | { kind: 'malformed'; path: string }
  | {
      kind: 'started';
      path: string;
      processId: number;
      child: ProcessState;
    }
  | {
      kind: 'adopted';
      path: string;
      processId: number;
      child: ProcessState;
      lead: ProcessState;
    };

export type SweepAction =
  | { kind: 'deleteMarker'; path: string }
  | { kind: 'leave' }
  | { kind: 'refuseRunning'; processId: number }
  | { kind: 'refuseMalformed'; path: string };

// A started marker proves the child took the ticket, not that Pi made a terminal. Only the kernel's
// answer that the child is gone proves no Pi can still run. An adopted marker's process already
// passed the fence and takes the lock at every later session start, so it never refuses. Its lead
// keeps the marker as evidence until the kernel reads both processes as gone.
export const sweepAction = (facts: SweepFacts): SweepAction => {
  if (facts.kind === 'malformed') {
    return { kind: 'refuseMalformed', path: facts.path };
  }

  if (facts.kind === 'adopted') {
    const bothGone = facts.child === 'gone' && facts.lead === 'gone';

    return bothGone ? { kind: 'deleteMarker', path: facts.path } : { kind: 'leave' };
  }

  return facts.child === 'gone'
    ? { kind: 'deleteMarker', path: facts.path }
    : { kind: 'refuseRunning', processId: facts.processId };
};
