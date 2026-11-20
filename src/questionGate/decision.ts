import type { JudgeVerdict } from './questionGate.ts';

export interface QuestionGateDecisionFacts {
  verdict: JudgeVerdict;
  cutoff: number;
}

export interface QuestionGateDecision {
  decision: 'decide' | 'ask';
  reason: 'confident' | 'belowCutoff' | 'timeout' | 'error' | 'unavailable';
  confidence: number | null;
}

export const questionGateDecision = (facts: QuestionGateDecisionFacts): QuestionGateDecision => {
  const { verdict, cutoff } = facts;

  if (verdict.kind === 'timeout') {
    return { decision: 'ask', reason: 'timeout', confidence: null };
  }

  if (verdict.kind === 'error') {
    return { decision: 'ask', reason: 'error', confidence: null };
  }

  if (verdict.kind === 'unavailable') {
    return { decision: 'ask', reason: 'unavailable', confidence: null };
  }

  if (verdict.confidence >= cutoff) {
    return { decision: 'decide', reason: 'confident', confidence: verdict.confidence };
  }

  return { decision: 'ask', reason: 'belowCutoff', confidence: verdict.confidence };
};
