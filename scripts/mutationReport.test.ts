import { describe, expect, it } from 'vitest';

import { formatMutationReport } from './mutationReport.js';
import type { Mutant } from './mutationReport.js';

const mutant = (fields: Partial<Mutant>): Mutant => ({
  mutatorName: 'Regex',
  replacement: '',
  status: 'Survived',
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  ...fields,
});

const reportOf = (files: Record<string, Mutant[]>) => ({
  files: Object.fromEntries(Object.entries(files).map(([path, mutants]) => [path, { mutants }])),
});

describe('formatMutationReport', () => {
  it('names the file, line, and change of a surviving mutant', () => {
    const source = 'one\nconst pattern = /a=[^=]+/;\n';

    const report = reportOf({
      'src/a.ts': [
        mutant({
          replacement: '/a=[^=]/',
          location: { start: { line: 2, column: 17 }, end: { line: 2, column: 26 } },
        }),
      ],
    });

    expect(formatMutationReport(report, { 'src/a.ts': source })).toBe(
      [
        'src/a.ts:2 Regex: /a=[^=]+/ -> /a=[^=]/',
        '1 mutants: 0 killed, 1 survived, 0 no coverage',
      ].join('\n'),
    );
  });

  it('labels a mutant no test covers', () => {
    const report = reportOf({ 'src/a.ts': [mutant({ status: 'NoCoverage', replacement: 'x' })] });

    expect(formatMutationReport(report, { 'src/a.ts': 'a' })).toContain(
      'src/a.ts:1 Regex: a -> x (no coverage)',
    );
  });

  it('joins a multi-line original and cuts a long one', () => {
    const source = `foo(\n  bar,\n${'z'.repeat(100)})`;

    const report = reportOf({
      'src/a.ts': [
        mutant({
          mutatorName: 'BlockStatement',
          replacement: '{}',
          location: { start: { line: 1, column: 1 }, end: { line: 3, column: 102 } },
        }),
      ],
    });

    const [line] = formatMutationReport(report, { 'src/a.ts': source }).split('\n');

    expect(line).toBe(`src/a.ts:1 BlockStatement: foo( bar, ${'z'.repeat(70)}... -> {}`);
  });

  it('sorts by path then line and counts every status', () => {
    const report = reportOf({
      'src/b.ts': [mutant({ status: 'Killed' }), mutant({ replacement: 'q' })],
      'src/a.ts': [
        mutant({
          location: { start: { line: 9, column: 1 }, end: { line: 9, column: 2 } },
        }),
        mutant({ status: 'Timeout' }),
        mutant({ status: 'Ignored' }),
        mutant({
          status: 'NoCoverage',
          location: { start: { line: 3, column: 1 }, end: { line: 3, column: 2 } },
        }),
      ],
    });

    const lines = formatMutationReport(report, {}).split('\n');

    expect(lines.map((line) => line.split(' ')[0])).toEqual([
      'src/a.ts:3',
      'src/a.ts:9',
      'src/b.ts:1',
      '5',
    ]);

    expect(lines.at(-1)).toBe('5 mutants: 2 killed, 2 survived, 1 no coverage');
  });

  it('sorts mutants on one line by column', () => {
    const report = reportOf({
      'src/a.ts': [
        mutant({
          replacement: 'late',
          location: { start: { line: 1, column: 5 }, end: { line: 1, column: 6 } },
        }),
        mutant({ replacement: 'early' }),
      ],
    });

    const lines = formatMutationReport(report, { 'src/a.ts': 'abcdef' }).split('\n');

    expect(lines.slice(0, 2)).toEqual([
      'src/a.ts:1 Regex: a -> early',
      'src/a.ts:1 Regex: e -> late',
    ]);
  });

  it('prints only the totals when nothing survives', () => {
    const report = reportOf({ 'src/a.ts': [mutant({ status: 'Killed' })] });

    expect(formatMutationReport(report, {})).toBe('1 mutants: 1 killed, 0 survived, 0 no coverage');
  });
});
