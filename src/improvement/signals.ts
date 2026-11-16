import type { MissingEvidence, TaskEvidence, TaskFact } from './taskFacts.ts';
import type { Coverage } from './taskMapping.ts';

type EvidenceKind = MissingEvidence['affects'][number];

export type SignalState = 'fired' | 'notFired' | 'unknown';

export interface ReviewSignals {
  reviewFixRounds: SignalState;
  feedbackRounds: SignalState;
  checkFailures: SignalState;
  revert: SignalState;
  qaAfterReview: SignalState;
}

export interface ReviewSignalFacts {
  evidence: TaskEvidence;
  reverted: boolean | 'unknown';
  coverage: Coverage;
}

const reviewFixRoundThreshold = 3;
const feedbackRoundThreshold = 3;
const checkFailureThreshold = 2;

const qaProfile = 'qa';

const affects = (missing: readonly MissingEvidence[], kinds: readonly EvidenceKind[]) =>
  missing.some((item) => item.affects.some((kind) => kinds.includes(kind)));

const countState = (count: number, threshold: number, unknown: boolean): SignalState => {
  if (count >= threshold) {
    return 'fired';
  }

  return unknown ? 'unknown' : 'notFired';
};

const firstIndexOf = (facts: readonly TaskFact[], kind: TaskFact['kind']) =>
  facts.findIndex((fact) => fact.kind === kind);

const lastIndexOf = (facts: readonly TaskFact[], kind: TaskFact['kind']) =>
  facts.findLastIndex((fact) => fact.kind === kind);

const reviewFixRounds = (evidence: TaskEvidence): SignalState => {
  const firstReview = firstIndexOf(evidence.facts, 'reviewCapture');

  const count =
    firstReview === -1
      ? 0
      : evidence.facts.filter((fact, index) => fact.kind === 'fixCapture' && index > firstReview)
          .length;

  const unknown = affects(evidence.missing, ['reviewCapture', 'fixCapture']);

  return countState(count, reviewFixRoundThreshold, unknown);
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

const qaAfterReview = (evidence: TaskEvidence): SignalState => {
  const lastReview = lastIndexOf(evidence.facts, 'reviewCapture');

  const fired =
    lastReview !== -1 &&
    evidence.facts.some(
      (fact, index) => index > lastReview && fact.kind === 'launch' && fact.profile === qaProfile,
    );

  if (fired) {
    return 'fired';
  }

  return affects(evidence.missing, ['reviewCapture', 'qaLaunch']) ? 'unknown' : 'notFired';
};

const transcriptSignals = (facts: ReviewSignalFacts): ReviewSignals => ({
  reviewFixRounds: reviewFixRounds(facts.evidence),
  feedbackRounds: feedbackRounds(facts.evidence),
  checkFailures: checkFailures(facts.evidence),
  revert: revert(facts.reverted),
  qaAfterReview: qaAfterReview(facts.evidence),
});

// Without a mapped, readable manager transcript, an absent fact says nothing about the task.
const readsTranscripts = (coverage: Coverage) =>
  coverage === 'complete' || coverage === 'managerOnly';

export const decideReviewSignals = (facts: ReviewSignalFacts): ReviewSignals => {
  if (!readsTranscripts(facts.coverage)) {
    return {
      reviewFixRounds: 'unknown',
      feedbackRounds: 'unknown',
      checkFailures: 'unknown',
      revert: revert(facts.reverted),
      qaAfterReview: 'unknown',
    };
  }

  return transcriptSignals(facts);
};
