import { expect, it } from 'vitest';

import { decideCall, decideEligibility } from './decideDecision.ts';
import type { DecideCall, DecideEligibility } from './decideDecision.ts';
import type { JudgeVerdict } from './questionGate.ts';
import type { ShadowQuestionFacts } from './shadowDecision.ts';

interface EligibilityRow {
  name: string;
  questions: readonly [ShadowQuestionFacts, ...ShadowQuestionFacts[]];
  expected: DecideEligibility;
}

interface CallRow {
  name: string;
  questions: readonly [ShadowQuestionFacts, ...ShadowQuestionFacts[]];
  verdicts: readonly [JudgeVerdict, ...JudgeVerdict[]];
  cutoff: number;
  expected: DecideCall;
}

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

const table: readonly (EligibilityRow | CallRow)[] = [
  {
    name: 'single choice decides',
    questions: [choice()],
    verdicts: [answered(0.97)],
    cutoff: 0.9,
    expected: { kind: 'decide', confidences: [0.97] },
  },
  {
    name: 'two-question batch decides',
    questions: [choice(), choice()],
    verdicts: [answered(0.95), answered(0.91)],
    cutoff: 0.9,
    expected: { kind: 'decide', confidences: [0.95, 0.91] },
  },
  {
    name: 'four-question batch decides',
    questions: [choice(), choice(), choice(), choice()],
    verdicts: [answered(0.93), answered(0.94), answered(0.95), answered(0.96)],
    cutoff: 0.9,
    expected: { kind: 'decide', confidences: [0.93, 0.94, 0.95, 0.96] },
  },
  {
    name: 'confidence equal to cutoff decides',
    questions: [choice()],
    verdicts: [answered(0.9)],
    cutoff: 0.9,
    expected: { kind: 'decide', confidences: [0.9] },
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

const decideOutcome = (row: EligibilityRow | CallRow): DecideEligibility | DecideCall => {
  const eligibility = decideEligibility(row.questions);

  if (eligibility.kind === 'ask' || !('verdicts' in row)) {
    return eligibility;
  }

  return decideCall({ verdicts: row.verdicts, cutoff: row.cutoff });
};

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(decideOutcome(row)).toEqual(row.expected);
});
