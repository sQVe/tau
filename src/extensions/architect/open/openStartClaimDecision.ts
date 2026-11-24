export interface OpenStartFacts {
  adopted: boolean;
  now: number;
  deadline: number;
  cancelled: boolean;
}

export type OpenStartProgress = 'waiting' | 'expired' | 'taken' | 'cancelled';

// Adoption by this caller's child is a takeover, even when the call was also cancelled.
export const openStartProgress = (facts: OpenStartFacts): OpenStartProgress => {
  if (facts.adopted) {
    return 'taken';
  }

  if (facts.cancelled) {
    return 'cancelled';
  }

  return facts.now < facts.deadline ? 'waiting' : 'expired';
};
