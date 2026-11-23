export interface OpenStartFacts {
  claimToken: string;
  holderToken: string | undefined;
  now: number;
  deadline: number;
}

export type OpenStartProgress = 'waiting' | 'expired' | 'taken';

// The claim is gone once another generation holds the lock, or once no holder is live.
export const openStartProgress = (facts: OpenStartFacts): OpenStartProgress => {
  if (facts.holderToken !== facts.claimToken) {
    return 'taken';
  }

  return facts.now < facts.deadline ? 'waiting' : 'expired';
};
