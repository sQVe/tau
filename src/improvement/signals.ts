import type { MissingEvidence, TaskEvidence } from './taskFacts.ts';
import type { Coverage } from './taskMapping.ts';

type EvidenceKind = MissingEvidence['affects'][number];

type SignalState = 'fired' | 'notFired' | 'unknown';

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

const reviewRounds = (evidence: TaskEvidence): SignalState => {
  const count = evidence.facts.filter((fact) => fact.kind === 'reviewCapture').length;
  const unknown = affects(evidence.missing, ['reviewCapture']);

  return countState(count, reviewRoundThreshold, unknown);
};

const feedbackRounds = (evidence: TaskEvidence): SignalState => {
  const count = evidence.facts.filter((fact) => fact.kind === 'feedbackRound').length;
  const unknown = affects(evidence.missing, ['feedbackRound']);

  return countState(count, feedbackRoundThreshold, unknown);
};

const checkFailures = (evidence: TaskEvidence): SignalState => {
  const count = evidence.facts.filter((fact) => fact.kind === 'checkFailure').length;
  const unknown = affects(evidence.missing, ['checkFailure']);

  return countState(count, checkFailureThreshold, unknown);
};

const revert = (reverted: boolean | 'unknown'): SignalState => {
  if (reverted === 'unknown') {
    return 'unknown';
  }

  return reverted ? 'fired' : 'notFired';
};

const transcriptSignals = (facts: ReviewSignalFacts): ReviewSignals => ({
  reviewRounds: reviewRounds(facts.evidence),
  feedbackRounds: feedbackRounds(facts.evidence),
  checkFailures: checkFailures(facts.evidence),
  revert: revert(facts.reverted),
});

const readsTranscripts = (coverage: Coverage) =>
  coverage === 'complete' || coverage === 'managerOnly';

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
