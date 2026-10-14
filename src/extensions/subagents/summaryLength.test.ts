import { expect, it } from 'vitest';

import { decideSummaryLength } from './summaryLength.js';

it.each([
  { length: 1, step: 'accept' },
  { length: 2999, step: 'accept' },
  { length: 3000, step: 'accept' },
  { length: 3001, step: 'refuse' },
  { length: 32_000, step: 'refuse' },
])('decides $step for a summary of $length characters', ({ length, step }) => {
  expect(decideSummaryLength({ length })).toBe(step);
});
