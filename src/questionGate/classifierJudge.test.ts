import { expect, it } from 'vitest';

import { judgeWithClassifier } from './classifierJudge.ts';
import type {
  ClassifierOutcome,
  ClassifyQuestion,
  JudgeQuestion,
  PastAnswer,
  PastOutcome,
} from './questionGate.ts';

interface ClassifyCall {
  state: Record<string, unknown>;
  asked: { instructions: string; criteria: Record<string, string> };
  signal: AbortSignal | undefined;
}

const question: JudgeQuestion = {
  question: 'Which route?',
  problem: 'The route is open.',
  impact: 'The wrong route wastes a day.',
  options: [
    { label: 'Fast', description: 'Ship now.', recommended: true },
    { label: 'Careful', description: 'Check first.', recommended: false },
  ],
};

const options = [
  { label: 'Fast', description: 'Ship now.' },
  { label: 'Careful', description: 'Check first.' },
];

const answer = (time: number, outcome: PastOutcome): PastAnswer => ({ time, question, outcome });

const classifyFixture = (outcome: ClassifierOutcome) => {
  const calls: ClassifyCall[] = [];

  const classify: ClassifyQuestion = async (state, asked, signal) => {
    calls.push({ state, asked, signal });

    return outcome;
  };

  return { classify, calls };
};

it('an accept label at 0.9 returns confidence 0.9', async () => {
  const { classify, calls } = classifyFixture({
    kind: 'answered',
    label: 'accept',
    confidence: 0.9,
  });

  const verdict = await judgeWithClassifier(classify, question, [], undefined);

  expect(verdict).toEqual({ kind: 'answered', confidence: 0.9 });

  expect(calls[0]?.asked).toEqual({
    instructions: 'Will the user pick the recommended option as it is, without changes?',
    criteria: {
      accept: 'The user picks the recommended option as it is.',
      other: 'The user picks another option or types their own answer.',
    },
  });

  expect(calls[0]?.signal).toBeUndefined();
});

it('an other label at 0.8 returns confidence 0.2', async () => {
  const { classify } = classifyFixture({ kind: 'answered', label: 'other', confidence: 0.8 });

  const verdict = await judgeWithClassifier(classify, question, [], undefined);

  expect(verdict).toEqual({ kind: 'answered', confidence: 1 - 0.8 });
});

it('an unknown label returns error', async () => {
  const { classify } = classifyFixture({ kind: 'answered', label: 'maybe', confidence: 0.7 });

  const verdict = await judgeWithClassifier(classify, question, [], undefined);

  expect(verdict).toEqual({ kind: 'error' });
});

it.for(['timeout', 'error', 'unavailable'] as const)('%s passes through', async (kind) => {
  const { classify } = classifyFixture({ kind });

  const verdict = await judgeWithClassifier(classify, question, [], undefined);

  expect(verdict).toEqual({ kind });
});

it('the classify state holds two examples with their answers', async () => {
  const { classify, calls } = classifyFixture({
    kind: 'answered',
    label: 'accept',
    confidence: 0.9,
  });

  const examples = [
    answer(1, { kind: 'recommended' }),
    answer(2, { kind: 'otherOption', label: 'Careful' }),
  ];

  await judgeWithClassifier(classify, question, examples, undefined);

  expect(calls[0]?.state).toEqual({
    question: question.question,
    problem: question.problem,
    impact: question.impact,
    options,
    recommended: 'Fast',
    examples: [
      {
        question: question.question,
        options,
        recommended: 'Fast',
        answer: 'recommended',
      },
      {
        question: question.question,
        options,
        recommended: 'Fast',
        answer: 'other option: Careful',
      },
    ],
  });
});

it('the classify state has no examples key without examples', async () => {
  const { classify, calls } = classifyFixture({
    kind: 'answered',
    label: 'accept',
    confidence: 0.9,
  });

  await judgeWithClassifier(classify, question, [], undefined);

  expect(calls[0]?.state).not.toHaveProperty('examples');
});

it('cuts a typed example answer to 300 characters', async () => {
  const { classify, calls } = classifyFixture({
    kind: 'answered',
    label: 'accept',
    confidence: 0.9,
  });

  await judgeWithClassifier(
    classify,
    question,
    [answer(1, { kind: 'typed', text: 'x'.repeat(301) })],
    undefined,
  );

  const examples = calls[0]?.state.examples as { answer: string }[];

  expect(examples[0]?.answer).toBe(`typed: ${'x'.repeat(300)}`);
});
