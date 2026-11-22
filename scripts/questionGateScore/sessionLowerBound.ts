export interface SessionObservation {
  session: string;
  hit: boolean;
}

export interface SessionSummary {
  decided: number;
  hits: number;
  sessions: number;
  lowerBound: number;
}

const confidenceLevel = 20;

const decidedCountsBySession = (observations: readonly SessionObservation[]): number[] => {
  const decidedBySession = new Map<string, number>();

  for (const observation of observations) {
    const decided = decidedBySession.get(observation.session) ?? 0;

    decidedBySession.set(observation.session, decided + 1);
  }

  return [...decidedBySession.values()];
};

const lowerBound = (decidedCounts: readonly number[], decided: number, hits: number): number => {
  if (decided === 0) {
    return 0;
  }

  const agreement = hits / decided;

  const squaredWeights = decidedCounts.reduce(
    (total, sessionDecided) => total + (sessionDecided / decided) ** 2,
    0,
  );

  const spread = Math.sqrt((Math.log(confidenceLevel) * squaredWeights) / 2);

  return Math.max(0, agreement - spread);
};

export const sessionSummary = (observations: readonly SessionObservation[]): SessionSummary => {
  const decidedCounts = decidedCountsBySession(observations);
  const decided = observations.length;
  const hits = observations.filter((observation) => observation.hit).length;

  return {
    decided,
    hits,
    sessions: decidedCounts.length,
    lowerBound: lowerBound(decidedCounts, decided, hits),
  };
};
