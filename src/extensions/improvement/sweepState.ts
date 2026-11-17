import type { SweepOutcome } from '../../improvement/sweep.js';

export interface SweepState {
  latest: () => SweepOutcome | undefined;
  record: (outcome: SweepOutcome) => void;
}

export const createSweepState = (): SweepState => {
  let latest: SweepOutcome | undefined;

  return {
    latest: () => latest,
    record: (outcome) => {
      latest = outcome;
    },
  };
};
