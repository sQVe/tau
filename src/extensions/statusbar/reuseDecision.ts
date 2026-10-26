export interface SessionKey {
  sessionId: string;
  leafId: string | null;
  entryCount: number;
}

export interface ReuseFacts {
  current: SessionKey;
  cachedCost: SessionKey | undefined;
  cachedUsage: SessionKey | undefined;
  usageAgeMilliseconds: number | undefined;
  modelUnchanged: boolean;
}

export interface ReuseDecision {
  cost: boolean;
  contextUsage: boolean;
}

const contextUsageLifetimeMilliseconds = 1000;

const sameLeafAndEntries = (cached: SessionKey, current: SessionKey): boolean =>
  cached.leafId === current.leafId && cached.entryCount === current.entryCount;

const sameSession = (cached: SessionKey | undefined, current: SessionKey): boolean =>
  cached !== undefined &&
  cached.sessionId === current.sessionId &&
  sameLeafAndEntries(cached, current);

const isFreshUsage = (ageMilliseconds: number | undefined): boolean =>
  ageMilliseconds !== undefined && ageMilliseconds < contextUsageLifetimeMilliseconds;

export const decideReuse = (facts: ReuseFacts): ReuseDecision => {
  const usageSameSession = sameSession(facts.cachedUsage, facts.current);
  const usageStillValid = isFreshUsage(facts.usageAgeMilliseconds) && facts.modelUnchanged;

  return {
    cost: sameSession(facts.cachedCost, facts.current),
    contextUsage: usageSameSession && usageStillValid,
  };
};
