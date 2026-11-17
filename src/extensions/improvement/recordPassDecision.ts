import type { EventGap, ImprovementEvent } from '../../improvement/event.js';

export interface PassFailure {
  projectRoot: string;
  reason: string;
}

export type PassRootDecision =
  | { kind: 'write' }
  | { kind: 'skip' }
  | { kind: 'failed'; failure: PassFailure };

export const decidePassRoot = (facts: {
  projectRoot: string;
  events: readonly ImprovementEvent[];
  gaps: readonly EventGap[];
}): PassRootDecision => {
  if (facts.events.length > 0) {
    return { kind: 'write' };
  }

  const [firstGap] = facts.gaps;

  if (firstGap === undefined) {
    return { kind: 'skip' };
  }

  return {
    kind: 'failed',
    failure: { projectRoot: facts.projectRoot, reason: `${firstGap.path}: ${firstGap.reason}` },
  };
};
