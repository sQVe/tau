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
// answer that the child is gone proves no Pi can still run. An adopted marker's child already passed
// that fence, but while it runs or cannot be read it still holds the session file open, so a start
// must refuse. A gone child with a live lead stays as that lead's evidence.
export const sweepAction = (facts: SweepFacts): SweepAction => {
  if (facts.kind === 'malformed') {
    return { kind: 'refuseMalformed', path: facts.path };
  }

  if (facts.kind === 'adopted') {
    if (facts.child !== 'gone') {
      return { kind: 'refuseRunning', processId: facts.processId };
    }

    return facts.lead === 'gone' ? { kind: 'deleteMarker', path: facts.path } : { kind: 'leave' };
  }

  return facts.child === 'gone'
    ? { kind: 'deleteMarker', path: facts.path }
    : { kind: 'refuseRunning', processId: facts.processId };
};
