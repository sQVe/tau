// Decides whether a worker may hand back incomplete work from facts the caller read.
// tests/structure.test.ts keeps this module pure.

export interface IncompleteReportFacts {
  blockerKind: BlockerKind;
  // Milliseconds of work left before the cancellation reserve, on the worker's clock.
  remaining: number;
  // Milliseconds from task creation to its deadline.
  window: number;
  // An earlier non-time blocker was refused.
  refusedBefore: boolean;
}

export type IncompleteReportStep = 'accept' | 'refuseTime' | 'refuseFirst';

export const blockerKinds = ['time', 'dependency', 'decision', 'limit'] as const;

type BlockerKind = (typeof blockerKinds)[number];

// Refuse once so an early handback costs a named blocker, but never so late that the report is lost.
export const decideIncompleteReport = (facts: IncompleteReportFacts): IncompleteReportStep => {
  const { blockerKind, remaining, window, refusedBefore } = facts;

  // A time blocker is true only in the last tenth of the work window, however often it is repeated.
  if (blockerKind === 'time') {
    return remaining < 0.1 * window ? 'accept' : 'refuseTime';
  }

  if (refusedBefore || remaining < Math.max(0.2 * window, 300_000)) {
    return 'accept';
  }

  return 'refuseFirst';
};
