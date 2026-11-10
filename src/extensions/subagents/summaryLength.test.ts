import { expect, it } from 'vitest';

import { shortenSummary, summaryLengthLimit } from './summaryLength.js';

const file = '/agent/assignments/a1/summary.md';
const line = `${'x'.repeat(99)}\n`;

it.each([
  { case: 'a short summary', summary: 'Done.', kept: 'Done.' },
  {
    case: 'a summary at the limit',
    summary: 'y'.repeat(summaryLengthLimit),
    kept: 'y'.repeat(summaryLengthLimit),
  },
  {
    case: 'a summary over the limit, cut at the last line break',
    summary: line.repeat(35),
    kept: `${line.repeat(28)}${'x'.repeat(99)}\nFull summary in ${file}; 601 characters cut.`,
  },
  {
    case: 'a summary over the limit without a line break, cut at the budget',
    summary: 'z'.repeat(3500),
    kept: `${'z'.repeat(2928)}\nFull summary in ${file}; 572 characters cut.`,
  },
])('returns the manager summary for $case', ({ summary, kept }) => {
  const shortened = shortenSummary({ summary, file });

  expect(shortened).toBe(kept);
  expect(shortened.length).toBeLessThanOrEqual(summaryLengthLimit);
});
