import type { ChoiceOutcome } from '../../classifier/classifier.js';

export interface GateDecisionFacts {
  outcome: ChoiceOutcome;
  cutoff: number;
}

export interface GateDecision {
  decision: 'specified' | 'open';
  label: string | null;
  confidence: number | null;
}

export const gateConfidenceCutoff = 0.7;

// Only a confident `specified` label lets the lead brief a worker itself. Every other outcome is
// open, so a timeout, an error, or a missing classifier never hides a design decision.
export const gateDecision = (facts: GateDecisionFacts): GateDecision => {
  const { outcome, cutoff } = facts;

  if (outcome.kind !== 'answered') {
    return { decision: 'open', label: null, confidence: null };
  }

  if (outcome.label === 'specified' && outcome.confidence >= cutoff) {
    return { decision: 'specified', label: outcome.label, confidence: outcome.confidence };
  }

  return { decision: 'open', label: outcome.label, confidence: outcome.confidence };
};
