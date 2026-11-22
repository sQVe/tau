import { questionGateDecision } from './decision/decision.ts';
import type { QuestionGateDecision } from './decision/decision.ts';
import type { JudgeVerdict } from './questionGate.ts';
import { questionEligibility } from './shadowDecision.ts';
import type { QuestionSkipReason, ShadowQuestionFacts } from './shadowDecision.ts';

export type DecideEligibility =
  | { kind: 'eligible' }
  | { kind: 'ask'; index: number; reason: QuestionSkipReason };

export interface DecideCallFacts {
  verdicts: readonly [JudgeVerdict, ...JudgeVerdict[]];
  cutoff: number;
}

export type DecideCall =
  | { kind: 'decide'; confidences: [number, ...number[]] }
  | {
      kind: 'ask';
      index: number;
      decision: Extract<QuestionGateDecision, { decision: 'ask' }>;
    };

export const decideDeadlineMilliseconds = 5_000;

export const decideEligibility = <Question extends ShadowQuestionFacts>(
  questions: readonly [Question, ...Question[]],
): DecideEligibility => {
  for (const [index, question] of questions.entries()) {
    const eligibility = questionEligibility(question);

    if (eligibility.kind === 'skip') {
      return { kind: 'ask', index, reason: eligibility.reason };
    }
  }

  return { kind: 'eligible' };
};

export const decideCall = (facts: DecideCallFacts): DecideCall => {
  const { verdicts, cutoff } = facts;
  const [firstVerdict, ...remainingVerdicts] = verdicts;
  const firstDecision = questionGateDecision({ verdict: firstVerdict, cutoff });

  if (firstDecision.decision === 'ask') {
    return { kind: 'ask', index: 0, decision: firstDecision };
  }

  const confidences: [number, ...number[]] = [firstDecision.confidence];

  for (const [offset, verdict] of remainingVerdicts.entries()) {
    const decision = questionGateDecision({ verdict, cutoff });

    if (decision.decision === 'ask') {
      return { kind: 'ask', index: offset + 1, decision };
    }

    confidences.push(decision.confidence);
  }

  return { kind: 'decide', confidences };
};
