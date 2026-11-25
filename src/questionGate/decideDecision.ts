import { questionGateDecision } from './decision/decision.ts';
import type { QuestionGateDecision } from './decision/decision.ts';
import type { JudgeVerdict } from './questionGate.ts';
import { questionEligibility } from './shadowDecision.ts';
import type { ShadowQuestionFacts, ShadowSkipReason } from './shadowDecision.ts';

export interface EligibleQuestion<Question extends ShadowQuestionFacts> {
  question: Question;
  recommended: Question['options'][number];
}

export type DecideEligibility<Question extends ShadowQuestionFacts> =
  | { kind: 'eligible'; row: EligibleQuestion<Question> }
  | { kind: 'ask'; reason: ShadowSkipReason };

export interface DecideCallFacts<Row> {
  row: Row & { verdict: JudgeVerdict };
  cutoff: number;
}

export type DecideCall<Row> =
  | { kind: 'decide'; row: Row & { confidence: number } }
  | { kind: 'ask'; decision: Extract<QuestionGateDecision, { decision: 'ask' }> };

export const decideDeadlineMilliseconds = 5_000;

export const decideAuditRate = 0.2;

export const decideAuditPicks = (random: number): boolean => random < decideAuditRate;

export const decideEligibility = <Question extends ShadowQuestionFacts>(
  questions: readonly [Question, ...Question[]],
): DecideEligibility<Question> => {
  if (questions.length > 1) {
    return { kind: 'ask', reason: 'multipleQuestions' };
  }

  const [question] = questions;
  const eligibility = questionEligibility(question);

  if (eligibility.kind === 'skip') {
    return { kind: 'ask', reason: eligibility.reason };
  }

  const recommended = question.options.find((option) => option.recommended === true);

  if (recommended === undefined) {
    throw new Error('An eligible question has no recommended option.');
  }

  return { kind: 'eligible', row: { question, recommended } };
};

export const decideCall = <Row>(facts: DecideCallFacts<Row>): DecideCall<Row> => {
  const { row, cutoff } = facts;
  const decision = questionGateDecision({ verdict: row.verdict, cutoff });

  if (decision.decision === 'ask') {
    return { kind: 'ask', decision };
  }

  return { kind: 'decide', row: { ...row, confidence: decision.confidence } };
};
