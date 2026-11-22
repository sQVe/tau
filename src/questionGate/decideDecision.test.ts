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
  questions: readonly [ShadowQuestionFacts, ...ShadowQuestionFacts[]];
  verdicts: readonly [JudgeVerdict, ...JudgeVerdict[]];
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

const at = <Item>(items: readonly Item[], index: number): Item => {
  const item = items[index];

  if (item === undefined) {
    throw new Error('The test row is missing a value.');
  }

  return item;
};

const nonEmpty = <Item>(items: readonly Item[]): [Item, ...Item[]] => {
  const [first, ...rest] = items;

  if (first === undefined) {
    throw new Error('The test row is empty.');
  }

  return [first, ...rest];
};

const recommendedOf = (question: ShadowQuestionFacts) => {
  const recommended = question.options.find((option) => option.recommended === true);

  if (recommended === undefined) {
    throw new Error('The test question needs a recommendation.');
  }

  return recommended;
};

const eligible = (
  questions: readonly [ShadowQuestionFacts, ...ShadowQuestionFacts[]],
): DecideEligibility<ShadowQuestionFacts> => ({
  kind: 'eligible',
  rows: nonEmpty(questions.map((question) => ({ question, recommended: recommendedOf(question) }))),
});

const decided = (
  questions: readonly [ShadowQuestionFacts, ...ShadowQuestionFacts[]],
  verdicts: readonly [JudgeVerdict, ...JudgeVerdict[]],
): DecideCall<JudgedEligibleQuestion> => ({
  kind: 'decide',
  rows: nonEmpty(
    questions.map((question, index) => {
      const verdict = at(verdicts, index);

      if (verdict.kind !== 'answered') {
        throw new Error('The test decide row needs an answered verdict.');
      }

      return {
        question,
        recommended: recommendedOf(question),
        verdict,
        confidence: verdict.confidence,
      };
    }),
  ),
});

const table: readonly (EligibilityRow | CallRow)[] = [
  {
    name: 'single choice is eligible',
    questions: [choice()],
    expected: eligible([choice()]),
  },
  {
    name: 'two-question batch is eligible',
    questions: [choice(), choice()],
    expected: eligible([choice(), choice()]),
  },
  {
    name: 'single choice decides',
    questions: [choice()],
    verdicts: [answered(0.97)],
    cutoff: 0.9,
    expected: decided([choice()], [answered(0.97)]),
  },
  {
    name: 'two-question batch decides',
    questions: [choice(), choice()],
    verdicts: [answered(0.95), answered(0.91)],
    cutoff: 0.9,
    expected: decided([choice(), choice()], [answered(0.95), answered(0.91)]),
  },
  {
    name: 'four-question batch decides',
    questions: [choice(), choice(), choice(), choice()],
    verdicts: [answered(0.93), answered(0.94), answered(0.95), answered(0.96)],
    cutoff: 0.9,
    expected: decided(
      [choice(), choice(), choice(), choice()],
      [answered(0.93), answered(0.94), answered(0.95), answered(0.96)],
    ),
  },
  {
    name: 'confidence equal to cutoff decides',
    questions: [choice()],
    verdicts: [answered(0.9)],
    cutoff: 0.9,
    expected: decided([choice()], [answered(0.9)]),
  },
  {
    name: 'below-cutoff verdict asks',
    questions: [choice()],
    verdicts: [answered(0.89)],
    cutoff: 0.9,
    expected: {
      kind: 'ask',
      index: 0,
      decision: { decision: 'ask', reason: 'belowCutoff', confidence: 0.89 },
    },
  },
  {
    name: 'pass, low verdict, timeout asks at 1',
    questions: [choice(), choice(), choice()],
    verdicts: [answered(0.95), answered(0.5), { kind: 'timeout' }],
    cutoff: 0.9,
    expected: {
      kind: 'ask',
      index: 1,
      decision: { decision: 'ask', reason: 'belowCutoff', confidence: 0.5 },
    },
  },
  {
    name: 'timeout verdict asks',
    questions: [choice()],
    verdicts: [{ kind: 'timeout' }],
    cutoff: 0.9,
    expected: { kind: 'ask', index: 0, decision: { decision: 'ask', reason: 'timeout' } },
  },
  {
    name: 'error verdict asks',
    questions: [choice()],
    verdicts: [{ kind: 'error' }],
    cutoff: 0.9,
    expected: { kind: 'ask', index: 0, decision: { decision: 'ask', reason: 'error' } },
  },
  {
    name: 'unavailable verdict asks',
    questions: [choice()],
    verdicts: [{ kind: 'unavailable' }],
    cutoff: 0.9,
    expected: { kind: 'ask', index: 0, decision: { decision: 'ask', reason: 'unavailable' } },
  },
  {
    name: 'approval question asks',
    questions: [choice({ kind: 'approval' })],
    expected: { kind: 'ask', index: 0, reason: 'kindApproval' },
  },
  {
    name: 'choice then approval asks at 1',
    questions: [choice(), choice({ kind: 'approval' })],
    expected: { kind: 'ask', index: 1, reason: 'kindApproval' },
  },
  {
    name: 'question preview asks',
    questions: [choice({ preview: 'draft' })],
    expected: { kind: 'ask', index: 0, reason: 'questionPreview' },
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
    expected: { kind: 'ask', index: 0, reason: 'optionPreview' },
  },
  {
    name: 'multi-select asks',
    questions: [choice({ multiSelect: true })],
    expected: { kind: 'ask', index: 0, reason: 'multiSelect' },
  },
  {
    name: 'missing kind asks',
    questions: [choice({ kind: undefined })],
    expected: { kind: 'ask', index: 0, reason: 'kindMissing' },
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
    expected: { kind: 'ask', index: 0, reason: 'noRecommendation' },
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
    expected: { kind: 'ask', index: 0, reason: 'manyRecommendations' },
  },
];

const decideOutcome = (
  row: EligibilityRow | CallRow,
): DecideEligibility<ShadowQuestionFacts> | DecideCall<JudgedEligibleQuestion> => {
  const eligibility = decideEligibility(row.questions);

  if (eligibility.kind === 'ask' || !('verdicts' in row)) {
    return eligibility;
  }

  const rows = nonEmpty(
    eligibility.rows.map((eligibleRow, index) => ({
      question: eligibleRow.question,
      recommended: eligibleRow.recommended,
      verdict: at(row.verdicts, index),
    })),
  );

  return decideCall<JudgedEligibleQuestion>({ rows, cutoff: row.cutoff });
};

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideOutcome(row)).toEqual(row.expected);
});
