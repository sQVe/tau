export type ClaimReleaseAction = 'release' | 'stop' | 'keep';

export interface ClaimReleaseFacts {
  launch: 'notRun' | 'failed' | 'started';
  adopted: boolean;
  terminal: 'unknown' | 'live' | 'ended';
  stopAttempted: boolean;
}

export const claimReleaseDecision = (facts: ClaimReleaseFacts): ClaimReleaseAction => {
  if (facts.launch !== 'started' || facts.adopted || facts.terminal === 'ended') {
    return 'release';
  }

  if (facts.terminal === 'unknown') {
    return 'keep';
  }

  return facts.stopAttempted ? 'keep' : 'stop';
};
