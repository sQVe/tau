import type { MissingEvidence, TaskEvidence, TaskFact } from './taskFacts.ts';
import type { Coverage } from './taskMapping.ts';

type EvidenceKind = MissingEvidence['affects'][number];

type SignalState = 'fired' | 'notFired' | 'unknown';

export type StoredSignals = Omit<ReviewSignals, 'revert'>;

export interface ReviewSignals {
  reviewRounds: SignalState;
  feedbackRounds: SignalState;
  checkFailures: SignalState;
  revert: SignalState;
}

export interface ReviewSignalFacts {
  evidence: TaskEvidence;
  reverted: boolean | 'unknown';
  coverage: Coverage;
}

const reviewRoundThreshold = 5;
const feedbackRoundThreshold = 3;
const checkFailureThreshold = 2;

const affects = (missing: readonly MissingEvidence[], kinds: readonly EvidenceKind[]) =>
  missing.some((item) => item.affects.some((kind) => kinds.includes(kind)));

const countState = (count: number, threshold: number, unknown: boolean): SignalState => {
  if (count >= threshold) {
    return 'fired';
  }

  return unknown ? 'unknown' : 'notFired';
};

const countSignal = (
  evidence: TaskEvidence,
  kind: TaskFact['kind'] & EvidenceKind,
  threshold: number,
): SignalState => {
  const count = evidence.facts.filter((fact) => fact.kind === kind).length;

  return countState(count, threshold, affects(evidence.missing, [kind]));
};

const storedSignal = (
  counts: Readonly<Record<string, number>>,
  key: string,
  threshold: number,
): SignalState => {
  const count = counts[key];

  return count === undefined ? 'unknown' : countState(count, threshold, false);
};

const revert = (reverted: boolean | 'unknown'): SignalState => {
  if (reverted === 'unknown') {
    return 'unknown';
  }

  return reverted ? 'fired' : 'notFired';
};

const transcriptSignals = (facts: ReviewSignalFacts): ReviewSignals => ({
  reviewRounds: countSignal(facts.evidence, 'reviewCapture', reviewRoundThreshold),
  feedbackRounds: countSignal(facts.evidence, 'feedbackRound', feedbackRoundThreshold),
  checkFailures: countSignal(facts.evidence, 'checkFailure', checkFailureThreshold),
  revert: revert(facts.reverted),
});

const readsTranscripts = (coverage: Coverage) =>
  coverage === 'complete' || coverage === 'managerOnly';

export const decideStoredSignals = (counts: Readonly<Record<string, number>>): StoredSignals => ({
  reviewRounds: storedSignal(counts, 'reviewCaptures', reviewRoundThreshold),
  feedbackRounds: storedSignal(counts, 'feedbackRounds', feedbackRoundThreshold),
  checkFailures: storedSignal(counts, 'checkFailures', checkFailureThreshold),
});

export const decideReviewSignals = (facts: ReviewSignalFacts): ReviewSignals => {
  if (!readsTranscripts(facts.coverage)) {
    return {
      reviewRounds: 'unknown',
      feedbackRounds: 'unknown',
      checkFailures: 'unknown',
      revert: revert(facts.reverted),
    };
  }

  return transcriptSignals(facts);
};
