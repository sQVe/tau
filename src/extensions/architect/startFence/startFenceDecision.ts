import type { ProcessState } from '../../../process/process.js';
import type { ClaimReleaseFacts } from '../claimRelease/claimReleaseDecision.js';

export type StartFencePhase =
  | 'noTicket'
  | 'active'
  | 'cancelled'
  | 'unread'
  | 'started'
  | 'takenWithoutProcess';

export type StartFenceTicketFact = ClaimReleaseFacts['ticket'];

export interface StartFenceCleanupFacts {
  kept: boolean;
  ticket: StartFenceTicketFact;
  child: ProcessState;
  processId: number | undefined;
}

const ticketFacts: Readonly<Record<StartFencePhase, StartFenceTicketFact>> = {
  noTicket: 'notCreated',
  active: 'taken',
  cancelled: 'cancelled',
  unread: 'unread',
  started: 'taken',
  takenWithoutProcess: 'taken',
};

export const startFenceTicketFact = (phase: StartFencePhase): StartFenceTicketFact =>
  ticketFacts[phase];

export const startFenceCancellable = (phase: StartFencePhase): boolean =>
  phase === 'active' || phase === 'started' || phase === 'takenWithoutProcess';

const claimReleased = (facts: StartFenceCleanupFacts): boolean => !facts.kept;
const ticketTaken = (facts: StartFenceCleanupFacts): boolean => facts.ticket === 'taken';

const startedChildGone = (facts: StartFenceCleanupFacts): boolean =>
  facts.child === 'gone' && facts.processId !== undefined;

// A released claim deletes the marker of the started child only when the kernel reports it gone.
export const startFenceMarkerToDelete = (facts: StartFenceCleanupFacts): number | undefined =>
  claimReleased(facts) && ticketTaken(facts) && startedChildGone(facts)
    ? facts.processId
    : undefined;
