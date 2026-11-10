import { expect, it } from 'vitest';

import { shortenSummary } from './summaryLength.js';

const file = '/agent/assignments/a1/summary.md';
const line = `${'x'.repeat(99)}\n`;
const note = (cut: string) => `\nFull summary in ${file}; ${cut} characters cut.`;
const longFile = 'f'.repeat(3000);

it.each([
  { case: 'a one-character summary', summary: 'a', file, shortened: 'a' },
  {
    case: 'a summary under the limit',
    summary: 'b'.repeat(2999),
    file,
    shortened: 'b'.repeat(2999),
  },
  { case: 'a summary at the limit', summary: 'c'.repeat(3000), file, shortened: 'c'.repeat(3000) },
  {
    case: 'a summary one character over the limit',
    summary: 'd'.repeat(3001),
    file,
    shortened: `${'d'.repeat(2928)}${note('73')}`,
  },
  {
    case: 'a summary at the input maximum',
    summary: 'e'.repeat(32_000),
    file,
    shortened: `${'e'.repeat(2927)}${note('29,073')}`,
  },
  {
    case: 'a summary whose last line break leaves no room for the note',
    summary: line.repeat(35),
    file,
    shortened: `${line.repeat(28)}${'x'.repeat(99)}${note('601')}`,
  },
  {
    case: 'a summary whose last line break fills the limit with the note',
    summary: `${'g'.repeat(2930)}\n${'h'.repeat(569)}`,
    file,
    shortened: `${'g'.repeat(2930)}${note('570')}`,
  },
  {
    case: 'a summary file path longer than the limit',
    summary: 'i'.repeat(3001),
    file: longFile,
    shortened: `\nFull summary in ${longFile}; 3,001 characters cut.`,
  },
])('returns the manager summary for $case', ({ summary, file: summaryFile, shortened }) => {
  expect(shortenSummary({ summary, file: summaryFile })).toBe(shortened);
});
