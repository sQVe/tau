export type ClaimReleaseAction = 'release' | 'stop' | 'keep';

export interface ClaimReleaseFacts {
  launch: 'notRun' | 'refused' | 'started';
  adopted: boolean;
  terminal: 'unknown' | 'live' | 'ended' | 'absent';
  stopAttempted: boolean;
}

export const claimReleaseDecision = (facts: ClaimReleaseFacts): ClaimReleaseAction => {
  if (facts.launch !== 'started' || facts.adopted) {
    return 'release';
  }

  if (facts.terminal === 'ended' || facts.terminal === 'absent') {
    return 'release';
  }

  if (facts.terminal === 'unknown') {
    return 'keep';
  }

  return facts.stopAttempted ? 'keep' : 'stop';
};
