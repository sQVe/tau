export interface TemporaryOutputFacts {
  matchesPrefix: boolean;
  isDirectory: boolean;
  ownerId: number | undefined;
  currentUserId: number | undefined;
  modifiedAt: number;
  now: number;
  retentionMilliseconds: number;
}

const hasDifferentOwner = (facts: TemporaryOutputFacts): boolean =>
  facts.ownerId !== undefined &&
  facts.currentUserId !== undefined &&
  facts.ownerId !== facts.currentUserId;

export const shouldRemoveTemporaryOutput = (facts: TemporaryOutputFacts): boolean => {
  if (!facts.matchesPrefix) {
    return false;
  }

  if (!facts.isDirectory) {
    return false;
  }

  if (hasDifferentOwner(facts)) {
    return false;
  }

  return facts.now - facts.modifiedAt > facts.retentionMilliseconds;
};
