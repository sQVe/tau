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

interface SessionTally {
  decided: number;
  hits: number;
}

const confidenceLevel = 20;

const sessionTallies = (observations: readonly SessionObservation[]): SessionTally[] => {
  const tallies = new Map<string, SessionTally>();

  for (const observation of observations) {
    const known = tallies.get(observation.session) ?? { decided: 0, hits: 0 };

    known.decided += 1;

    if (observation.hit) {
      known.hits += 1;
    }

    tallies.set(observation.session, known);
  }

  return [...tallies.values()];
};

const lowerBound = (tallies: readonly SessionTally[], decided: number, hits: number): number => {
  if (decided === 0) {
    return 0;
  }

  const agreement = hits / decided;

  const squaredWeights = tallies.reduce(
    (total, tally) => total + (tally.decided / decided) ** 2,
    0,
  );

  const spread = Math.sqrt((Math.log(confidenceLevel) * squaredWeights) / 2);

  return Math.max(0, agreement - spread);
};

export const sessionSummary = (observations: readonly SessionObservation[]): SessionSummary => {
  const tallies = sessionTallies(observations);
  const decided = observations.length;
  const hits = observations.filter((observation) => observation.hit).length;

  return {
    decided,
    hits,
    sessions: tallies.length,
    lowerBound: lowerBound(tallies, decided, hits),
  };
};
