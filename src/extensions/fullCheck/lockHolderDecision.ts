export interface LockHolderFacts {
  // Whether the highest generation holds a readable owner record.
  recorded: boolean;
  released: boolean;
  sessionAlive: boolean;
  // Whether the recorded command is still running. False when no command was recorded.
  commandAlive: boolean;
}

// A lock can be taken over when its holder released it, left no record, or lost both its session
// and its command. A command outlives its session, so a live command keeps the lock.
export const holderIsGone = (facts: LockHolderFacts): boolean => {
  if (!facts.recorded || facts.released) {
    return true;
  }

  return !facts.sessionAlive && !facts.commandAlive;
};
