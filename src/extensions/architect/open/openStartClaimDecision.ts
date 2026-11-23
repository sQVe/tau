export interface OpenStartFacts {
  claimToken: string;
  holderToken: string | undefined;
  now: number;
  deadline: number;
  cancelled: boolean;
}

export type OpenStartProgress = 'waiting' | 'expired' | 'taken' | 'cancelled';

// A holder that is not this claim has taken over, even when the call was also cancelled.
export const openStartProgress = (facts: OpenStartFacts): OpenStartProgress => {
  if (facts.holderToken !== facts.claimToken) {
    return 'taken';
  }

  if (facts.cancelled) {
    return 'cancelled';
  }

  return facts.now < facts.deadline ? 'waiting' : 'expired';
};
