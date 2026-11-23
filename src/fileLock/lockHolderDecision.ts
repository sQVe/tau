export interface LockHolderFacts {
  // Whether the highest generation holds a readable owner record.
  recorded: boolean;
  released: boolean;
  sessionAlive: boolean;
  // Whether the recorded command is still running. False when no command was recorded.
  commandAlive: boolean;
}

export interface LockAdoptionFacts {
  holderToken: string | undefined;
  released: boolean;
  adoptToken: string | undefined;
}

export interface LockTakeoverFacts {
  facts: LockHolderFacts;
  holderToken: string | undefined;
  adoptToken: string | undefined;
}

// A lock can be taken over when its holder released it, left no record, or lost both its session
// and its command. A command outlives its session, so a live command keeps the lock.
export const holderIsGone = (facts: LockHolderFacts): boolean => {
  if (!facts.recorded || facts.released) {
    return true;
  }

  return !facts.sessionAlive && !facts.commandAlive;
};

// A record read before the session was seen dead can miss a command that the session recorded
// later. Only the session writes its record, so a record read after its death is final.
export const recordNeedsRereading = (facts: LockHolderFacts): boolean =>
  facts.recorded && !facts.released && holderIsGone(facts);

// A holder that left no token is never a claim to take over, even when the caller passes none.
export const claimIsAdoptable = (facts: LockAdoptionFacts): boolean => {
  const { holderToken, released, adoptToken } = facts;

  if (adoptToken === undefined || adoptToken === '') {
    return false;
  }

  return !released && holderToken === adoptToken;
};

// Without an adopt token, only a gone holder is takeable. With one, the holder must be the claim
// that names it, so a missing, released, or replaced claim is refused.
export const holderIsTakeable = ({
  facts,
  holderToken,
  adoptToken,
}: LockTakeoverFacts): boolean => {
  if (adoptToken === undefined || adoptToken === '') {
    return holderIsGone(facts);
  }

  return claimIsAdoptable({ holderToken, released: facts.released, adoptToken });
};
