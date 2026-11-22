import type { JudgeVerdict } from './questionGate.ts';

export interface QuestionGateDecisionFacts {
  verdict: JudgeVerdict;
  cutoff: number;
}

export type QuestionGateDecision =
  | { decision: 'decide'; confidence: number }
  | { decision: 'ask'; reason: 'belowCutoff'; confidence: number }
  | { decision: 'ask'; reason: 'timeout' | 'error' | 'unavailable' };

export const questionGateDecision = (facts: QuestionGateDecisionFacts): QuestionGateDecision => {
  const { verdict, cutoff } = facts;

  if (verdict.kind === 'timeout') {
    return { decision: 'ask', reason: 'timeout' };
  }

  if (verdict.kind === 'error') {
    return { decision: 'ask', reason: 'error' };
  }

  if (verdict.kind === 'unavailable') {
    return { decision: 'ask', reason: 'unavailable' };
  }

  if (verdict.confidence >= cutoff) {
    return { decision: 'decide', confidence: verdict.confidence };
  }

  return { decision: 'ask', reason: 'belowCutoff', confidence: verdict.confidence };
};
