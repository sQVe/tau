import type { ProcessState } from '../../../process/process.js';
import { claimReleaseDecision } from '../claimRelease/claimReleaseDecision.js';
import type { ClaimReleaseFacts } from '../claimRelease/claimReleaseDecision.js';

export type StartFenceTicketFact = ClaimReleaseFacts['ticket'];

export type StartFenceOutcome = 'cancelled' | 'gone' | 'adopted' | 'unresolved';

export interface StartFenceCompletionFacts {
  ticket: StartFenceTicketFact;
  child: ProcessState;
  adopted: boolean;
  processId: number | undefined;
}

export interface StartFenceCompletionPlan {
  outcome: StartFenceOutcome;
  claim: 'release' | 'keep';
  marker: 'delete' | 'keep';
}

export interface StartFenceTakeoverFacts {
  adopted: boolean;
  gone: boolean;
  now: number;
  deadline: number;
  cancelled: boolean;
}

export type StartFenceTakeoverProgress = 'waiting' | 'adopted' | 'gone' | 'expired' | 'cancelled';

export type StartFenceTakeover = Exclude<StartFenceTakeoverProgress, 'waiting'>;

const ticketOutcome = (ticket: StartFenceTicketFact): StartFenceOutcome | undefined => {
  if (ticket === 'notCreated' || ticket === 'cancelled') {
    return 'cancelled';
  }

  return ticket === 'unread' ? 'unresolved' : undefined;
};

const childOutcome = (facts: StartFenceCompletionFacts): StartFenceOutcome => {
  if (facts.child === 'gone') {
    return 'gone';
  }

  return facts.adopted ? 'adopted' : 'unresolved';
};

export const startFenceCompletionDecision = (
  facts: StartFenceCompletionFacts,
): StartFenceCompletionPlan => {
  const outcome = ticketOutcome(facts.ticket) ?? childOutcome(facts);

  const action = claimReleaseDecision({
    ticket: facts.ticket,
    adopted: facts.adopted,
    child: facts.child,
    stopAttempted: true,
  });

  const released = action === 'release';

  const marker =
    outcome === 'gone' && released && facts.processId !== undefined ? 'delete' : 'keep';

  return { outcome, claim: released ? 'release' : 'keep', marker };
};

export const startFenceTakeoverDecision = (
  facts: StartFenceTakeoverFacts,
): StartFenceTakeoverProgress => {
  if (facts.adopted) {
    return 'adopted';
  }

  if (facts.cancelled) {
    return 'cancelled';
  }

  if (facts.now >= facts.deadline) {
    return 'expired';
  }

  return facts.gone ? 'gone' : 'waiting';
};
