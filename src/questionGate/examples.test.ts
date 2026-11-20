import { expect, it } from 'vitest';

import { exampleCount, pastExamples } from './examples.ts';
import type { PastAnswer } from './questionGate.ts';

const question = {
  question: 'Which route?',
  problem: 'The route is open.',
  impact: 'The wrong route wastes a day.',
  options: [
    { label: 'Fast', description: 'Ship now.', recommended: true },
    { label: 'Careful', description: 'Check first.', recommended: false },
  ],
};

const answer = (time: number): PastAnswer => ({
  time,
  question,
  outcome: { kind: 'recommended' },
});

it('returns only answers older than before, oldest first', () => {
  const answers = [answer(3), answer(1), answer(2), answer(4)];

  expect(pastExamples(answers, 3, exampleCount)).toEqual([answer(1), answer(2)]);
});

it('keeps the input order of equal times', () => {
  const first = { ...answer(1), outcome: { kind: 'typed', text: 'first' } } as const;
  const second = { ...answer(1), outcome: { kind: 'typed', text: 'second' } } as const;

  expect(pastExamples([first, second], 2, exampleCount)).toEqual([first, second]);
});

it('returns the newest count older answers, oldest first', () => {
  const answers = [answer(1), answer(2), answer(3), answer(4), answer(5), answer(6)];

  expect(pastExamples(answers, 7, 2)).toEqual([answer(5), answer(6)]);
});

it('sorts older answers before keeping the newest count', () => {
  const answers = [answer(6), answer(1), answer(5), answer(2), answer(4), answer(3)];

  expect(pastExamples(answers, 7, 2)).toEqual([answer(5), answer(6)]);
});

it('returns an empty list when no answer is older', () => {
  expect(pastExamples([answer(1), answer(2)], 1, exampleCount)).toEqual([]);
});

it('returns an empty list for a count of 0 even with older answers', () => {
  expect(pastExamples([answer(1), answer(2)], 3, 0)).toEqual([]);
});

it('returns an empty list for a negative count even with older answers', () => {
  expect(pastExamples([answer(1), answer(2)], 3, -1)).toEqual([]);
});
