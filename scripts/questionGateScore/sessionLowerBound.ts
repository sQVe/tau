export interface SessionTally {
  decided: number;
  hits: number;
}

const confidenceLevel = 20;

export const sessionLowerBound = (tallies: readonly SessionTally[]): number => {
  const decided = tallies.reduce((total, tally) => total + tally.decided, 0);

  if (decided === 0) {
    return 0;
  }

  const hits = tallies.reduce((total, tally) => total + tally.hits, 0);
  const agreement = hits / decided;

  const squaredWeights = tallies.reduce(
    (total, tally) => total + (tally.decided / decided) ** 2,
    0,
  );

  const spread = Math.sqrt((Math.log(confidenceLevel) * squaredWeights) / 2);

  return Math.max(0, agreement - spread);
};
