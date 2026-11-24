import { expect, it } from 'vitest';

import { decideCall, decideEligibility } from './decideDecision.ts';
import type { DecideCall, DecideEligibility, EligibleQuestion } from './decideDecision.ts';
import type { JudgeVerdict } from './questionGate.ts';
import type { ShadowQuestionFacts } from './shadowDecision.ts';

interface EligibilityRow {
  name: string;
  questions: readonly [ShadowQuestionFacts, ...ShadowQuestionFacts[]];
  expected: DecideEligibility<ShadowQuestionFacts>;
}

interface CallRow {
  name: string;
  question: ShadowQuestionFacts;
  verdict: JudgeVerdict;
  cutoff: number;
  expected: DecideCall<JudgedEligibleQuestion>;
}

type JudgedEligibleQuestion = EligibleQuestion<ShadowQuestionFacts> & { verdict: JudgeVerdict };

const choice = (overrides: Partial<ShadowQuestionFacts> = {}): ShadowQuestionFacts => ({
  kind: 'choice',
  multiSelect: false,
  preview: undefined,
  options: [
    { recommended: true, preview: undefined },
    { recommended: false, preview: undefined },
  ],
  ...overrides,
});

const answered = (confidence: number): JudgeVerdict => ({ kind: 'answered', confidence });

const recommendedOf = (question: ShadowQuestionFacts) => {
  const recommended = question.options.find((option) => option.recommended === true);

  if (recommended === undefined) {
    throw new Error('The test question needs a recommendation.');
  }

  return recommended;
};

const eligible = (question: ShadowQuestionFacts): DecideEligibility<ShadowQuestionFacts> => ({
  kind: 'eligible',
  row: { question, recommended: recommendedOf(question) },
});

const decided = (
  question: ShadowQuestionFacts,
  verdict: JudgeVerdict,
): DecideCall<JudgedEligibleQuestion> => {
  if (verdict.kind !== 'answered') {
    throw new Error('The test decide row needs an answered verdict.');
  }

  return {
    kind: 'decide',
    row: {
      question,
      recommended: recommendedOf(question),
      verdict,
      confidence: verdict.confidence,
    },
  };
};

const table: readonly (EligibilityRow | CallRow)[] = [
  {
    name: 'single choice is eligible',
    questions: [choice()],
    expected: eligible(choice()),
  },
  {
    name: 'two-question batch asks',
    questions: [choice(), choice()],
    expected: { kind: 'ask', reason: 'multipleQuestions' },
  },
  {
    name: 'four-question batch asks',
    questions: [choice(), choice(), choice(), choice()],
    expected: { kind: 'ask', reason: 'multipleQuestions' },
  },
  {
    name: 'single choice decides',
    question: choice(),
    verdict: answered(0.97),
    cutoff: 0.9,
    expected: decided(choice(), answered(0.97)),
  },
  {
    name: 'confidence equal to cutoff decides',
    question: choice(),
    verdict: answered(0.9),
    cutoff: 0.9,
    expected: decided(choice(), answered(0.9)),
  },
  {
    name: 'below-cutoff verdict asks',
    question: choice(),
    verdict: answered(0.89),
    cutoff: 0.9,
    expected: {
      kind: 'ask',
      decision: { decision: 'ask', reason: 'belowCutoff', confidence: 0.89 },
    },
  },
  {
    name: 'timeout verdict asks',
    question: choice(),
    verdict: { kind: 'timeout' },
    cutoff: 0.9,
    expected: { kind: 'ask', decision: { decision: 'ask', reason: 'timeout' } },
  },
  {
    name: 'error verdict asks',
    question: choice(),
    verdict: { kind: 'error' },
    cutoff: 0.9,
    expected: { kind: 'ask', decision: { decision: 'ask', reason: 'error' } },
  },
  {
    name: 'unavailable verdict asks',
    question: choice(),
    verdict: { kind: 'unavailable' },
    cutoff: 0.9,
    expected: { kind: 'ask', decision: { decision: 'ask', reason: 'unavailable' } },
  },
  {
    name: 'approval question asks',
    questions: [choice({ kind: 'approval' })],
    expected: { kind: 'ask', reason: 'kindApproval' },
  },
  {
    name: 'question preview asks',
    questions: [choice({ preview: 'draft' })],
    expected: { kind: 'ask', reason: 'questionPreview' },
  },
  {
    name: 'option preview asks',
    questions: [
      choice({
        options: [
          { recommended: true, preview: 'one' },
          { recommended: false, preview: undefined },
        ],
      }),
    ],
    expected: { kind: 'ask', reason: 'optionPreview' },
  },
  {
    name: 'multi-select asks',
    questions: [choice({ multiSelect: true })],
    expected: { kind: 'ask', reason: 'multiSelect' },
  },
  {
    name: 'missing kind asks',
    questions: [choice({ kind: undefined })],
    expected: { kind: 'ask', reason: 'kindMissing' },
  },
  {
    name: 'no recommendation asks',
    questions: [
      choice({
        options: [
          { recommended: false, preview: undefined },
          { recommended: false, preview: undefined },
        ],
      }),
    ],
    expected: { kind: 'ask', reason: 'noRecommendation' },
  },
  {
    name: 'two recommendations asks',
    questions: [
      choice({
        options: [
          { recommended: true, preview: undefined },
          { recommended: true, preview: undefined },
        ],
      }),
    ],
    expected: { kind: 'ask', reason: 'manyRecommendations' },
  },
];

const decideOutcome = (
  row: EligibilityRow | CallRow,
): DecideEligibility<ShadowQuestionFacts> | DecideCall<JudgedEligibleQuestion> => {
  if (!('verdict' in row)) {
    return decideEligibility(row.questions);
  }

  const eligibility = decideEligibility([row.question]);

  if (eligibility.kind === 'ask') {
    return eligibility;
  }

  return decideCall<JudgedEligibleQuestion>({
    row: { ...eligibility.row, verdict: row.verdict },
    cutoff: row.cutoff,
  });
};

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideOutcome(row)).toEqual(row.expected);
});
