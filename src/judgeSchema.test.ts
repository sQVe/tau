import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import { openPastAnswerSchema, pastAnswerSchema } from './judgeSchema.js';

const option = { label: 'Fast', description: 'Ship now.', recommended: true };

const question = {
  question: 'Which route?',
  problem: 'The route is open.',
  impact: 'The wrong route wastes a day.',
  options: [option],
};

const pastAnswer = {
  time: 1,
  question,
  outcome: { kind: 'typed', text: 'first' },
};

it('accepts a past answer without extra keys in the strict and open schemas', () => {
  expect(Value.Check(pastAnswerSchema, pastAnswer)).toBe(true);
  expect(Value.Check(openPastAnswerSchema, pastAnswer)).toBe(true);
});

it.for<[string, unknown]>([
  ['past answer', { ...pastAnswer, extra: true }],
  ['question', { ...pastAnswer, question: { ...question, extra: true } }],
  ['option', { ...pastAnswer, question: { ...question, options: [{ ...option, extra: true }] } }],
  ['outcome', { ...pastAnswer, outcome: { ...pastAnswer.outcome, extra: true } }],
])(
  'rejects an extra key on the %s in the strict schema and accepts it in the open schema',
  ([, value]) => {
    expect(Value.Check(pastAnswerSchema, value)).toBe(false);
    expect(Value.Check(openPastAnswerSchema, value)).toBe(true);
  },
);
