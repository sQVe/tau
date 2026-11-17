import type { ChoiceOutcome } from '../../classifier/classifier.js';

export interface GateDecisionFacts {
  outcome: ChoiceOutcome;
  cutoff: number;
}

type GateDecisionValue = 'specified' | 'open' | 'uncertain';

export interface GateDecision {
  decision: GateDecisionValue;
  label: string | null;
  confidence: number | null;
}

export const gateConfidenceCutoff = 0.7;

// Only a confident label picks a path. Any other outcome is uncertain, so a timeout, an error, or
// a missing classifier never hides a design decision.
export const gateDecision = (facts: GateDecisionFacts): GateDecision => {
  const { outcome, cutoff } = facts;

  if (outcome.kind !== 'answered') {
    return { decision: 'uncertain', label: null, confidence: null };
  }

  if (outcome.label === 'specified' && outcome.confidence >= cutoff) {
    return { decision: 'specified', label: outcome.label, confidence: outcome.confidence };
  }

  if (outcome.label === 'open' && outcome.confidence >= cutoff) {
    return { decision: 'open', label: outcome.label, confidence: outcome.confidence };
  }

  return { decision: 'uncertain', label: outcome.label, confidence: outcome.confidence };
};
