import { questionGateDecision } from './decision/decision.ts';
import type { QuestionGateDecision } from './decision/decision.ts';
import type { JudgeVerdict } from './questionGate.ts';
import { questionEligibility } from './shadowDecision.ts';
import type { QuestionSkipReason, ShadowQuestionFacts } from './shadowDecision.ts';

export interface EligibleQuestion<Question extends ShadowQuestionFacts> {
  question: Question;
  recommended: Question['options'][number];
}

export type DecideEligibility<Question extends ShadowQuestionFacts> =
  | { kind: 'eligible'; rows: [EligibleQuestion<Question>, ...EligibleQuestion<Question>[]] }
  | { kind: 'ask'; index: number; reason: QuestionSkipReason };

export interface DecideCallFacts<Row> {
  rows: readonly [Row & { verdict: JudgeVerdict }, ...(Row & { verdict: JudgeVerdict })[]];
  cutoff: number;
}

export type DecideCall<Row> =
  | { kind: 'decide'; rows: [Row & { confidence: number }, ...(Row & { confidence: number })[]] }
  | {
      kind: 'ask';
      index: number;
      decision: Extract<QuestionGateDecision, { decision: 'ask' }>;
    };

export const decideDeadlineMilliseconds = 5_000;

export const mapNonEmpty = <Item, Result>(
  items: readonly [Item, ...Item[]],
  map: (item: Item, index: number) => Result,
): [Result, ...Result[]] => {
  const [first, ...rest] = items;

  return [map(first, 0), ...rest.map((item, index) => map(item, index + 1))];
};

export const decideEligibility = <Question extends ShadowQuestionFacts>(
  questions: readonly [Question, ...Question[]],
): DecideEligibility<Question> => {
  for (const [index, question] of questions.entries()) {
    const eligibility = questionEligibility(question);

    if (eligibility.kind === 'skip') {
      return { kind: 'ask', index, reason: eligibility.reason };
    }
  }

  return {
    kind: 'eligible',
    rows: mapNonEmpty(questions, (question) => {
      const recommended = question.options.find((option) => option.recommended === true);

      if (recommended === undefined) {
        throw new Error('An eligible question has no recommended option.');
      }

      return { question, recommended };
    }),
  };
};

export const decideCall = <Row>(facts: DecideCallFacts<Row>): DecideCall<Row> => {
  const { rows, cutoff } = facts;

  const decisions = mapNonEmpty(rows, (row) =>
    questionGateDecision({ verdict: row.verdict, cutoff }),
  );

  for (const [index, decision] of decisions.entries()) {
    if (decision.decision === 'ask') {
      return { kind: 'ask', index, decision };
    }
  }

  return {
    kind: 'decide',
    rows: mapNonEmpty(rows, (row, index) => {
      const decision = decisions[index];

      if (decision?.decision !== 'decide') {
        throw new Error('Expected a decide result for every row.');
      }

      return { ...row, confidence: decision.confidence };
    }),
  };
};
