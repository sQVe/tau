export type ClaimReleaseAction = 'release' | 'stop' | 'keep';

export interface ClaimReleaseFacts {
  ticket: 'notCreated' | 'cancelled' | 'taken' | 'unread';
  adopted: boolean;
  child: 'running' | 'gone' | 'unknown';
  stopAttempted: boolean;
}

export const claimReleaseDecision = (facts: ClaimReleaseFacts): ClaimReleaseAction => {
  if (facts.ticket === 'notCreated' || facts.ticket === 'cancelled') {
    return 'release';
  }

  if (facts.ticket === 'unread') {
    return 'keep';
  }

  if (facts.adopted) {
    return 'release';
  }

  if (facts.child === 'gone') {
    return 'release';
  }

  if (facts.child === 'unknown') {
    return 'keep';
  }

  return facts.stopAttempted ? 'keep' : 'stop';
};
