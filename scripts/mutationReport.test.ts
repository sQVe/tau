import { describe, expect, it } from 'vitest';

import { buildMutationReport, failedMutationReport } from './mutationReport.js';
import type { Mutant, MutationFacts } from './mutationReport.js';

const mutant = (fields: Partial<Mutant>): Mutant => ({
  mutatorName: 'Regex',
  replacement: '',
  status: 'Survived',
  location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  ...fields,
});

const factsOf = (
  files: Record<string, Mutant[]>,
  fields: Partial<MutationFacts> = {},
): MutationFacts => ({
  mode: 'changed',
  stryker: {
    files: Object.fromEntries(Object.entries(files).map(([path, mutants]) => [path, { mutants }])),
  },
  sources: {},
  unmutated: [],
  ...fields,
});

const at = (line: number, column: number) => ({
  start: { line, column },
  end: { line, column: column + 1 },
});

describe('buildMutationReport', () => {
  it.each([
    {
      name: 'a cap that leaves a file unmutated',
      facts: factsOf({ 'src/a.ts': [mutant({ status: 'Killed' })] }, { unmutated: ['src/b.ts'] }),
      status: 'error',
      exitCode: 1,
      unmutated: ['src/b.ts'],
    },
    {
      name: 'a cap that leaves two files unmutated in audit mode',
      facts: factsOf(
        {},
        { mode: 'audit', stryker: undefined, unmutated: ['src/a.ts', 'src/b.ts'] },
      ),
      status: 'error',
      exitCode: 1,
      unmutated: ['src/a.ts', 'src/b.ts'],
    },
    {
      name: 'a failed run',
      facts: factsOf({}, { stryker: undefined, error: 'Stryker failed' }),
      status: 'error',
      exitCode: 1,
      unmutated: [],
    },
    {
      name: 'no Stryker run',
      facts: factsOf({}, { stryker: undefined }),
      status: 'nothing',
      exitCode: 0,
      unmutated: [],
    },
    {
      name: 'a run with no mutant',
      facts: factsOf({ 'src/a.ts': [mutant({ status: 'Ignored' })] }),
      status: 'nothing',
      exitCode: 0,
      unmutated: [],
    },
    {
      name: 'only invalid mutants',
      facts: factsOf({
        'src/a.ts': [mutant({ status: 'CompileError' }), mutant({ status: 'RuntimeError' })],
      }),
      status: 'error',
      exitCode: 1,
      unmutated: [],
    },
    {
      name: 'killed mutants and an invalid one',
      facts: factsOf({
        'src/a.ts': [mutant({ status: 'Killed' }), mutant({ status: 'CompileError' })],
      }),
      status: 'pass',
      exitCode: 0,
      unmutated: [],
    },
    {
      name: 'a survivor in changed mode',
      facts: factsOf({ 'src/a.ts': [mutant({})] }),
      status: 'survivors',
      exitCode: 2,
      unmutated: [],
    },
    {
      name: 'an uncovered mutant in changed mode',
      facts: factsOf({ 'src/a.ts': [mutant({ status: 'NoCoverage' })] }),
      status: 'survivors',
      exitCode: 2,
      unmutated: [],
    },
    {
      name: 'a survivor in audit mode',
      facts: factsOf({ 'src/a.ts': [mutant({})] }, { mode: 'audit' }),
      status: 'survivors',
      exitCode: 0,
      unmutated: [],
    },
  ])('gives $status and exit $exitCode for $name', ({ facts, status, exitCode, unmutated }) => {
    const result = buildMutationReport(facts);

    expect(result.report.status).toBe(status);
    expect(result.exitCode).toBe(exitCode);
    expect(result.report.unmutated).toEqual(unmutated);
  });

  it('lists each unmutated file and keeps the survivors of the files that ran', () => {
    const facts = factsOf({ 'src/a.ts': [mutant({})] }, { unmutated: ['src/b.ts', 'src/c.ts'] });

    const { report, exitCode } = buildMutationReport(facts);

    expect(exitCode).toBe(1);
    expect(report.unmutated).toEqual(['src/b.ts', 'src/c.ts']);
    expect(report.survivors).toHaveLength(1);
  });

  it('lists audit survivors with file, line, mutator, original, and replacement', () => {
    const source = 'one\nconst pattern = /a=[^=]+/;\n';

    const facts = factsOf(
      {
        'src/a.ts': [
          mutant({
            replacement: '/a=[^=]/',
            location: { start: { line: 2, column: 17 }, end: { line: 2, column: 26 } },
          }),
        ],
      },
      { mode: 'audit', sources: { 'src/a.ts': source } },
    );

    const { report, exitCode } = buildMutationReport(facts);

    expect(exitCode).toBe(0);

    expect(report.survivors).toEqual([
      {
        file: 'src/a.ts',
        line: 2,
        column: 17,
        mutator: 'Regex',
        original: '/a=[^=]+/',
        replacement: '/a=[^=]/',
        covered: true,
      },
    ]);
  });

  it('marks an uncovered survivor', () => {
    const facts = factsOf({ 'src/a.ts': [mutant({ status: 'NoCoverage', replacement: 'x' })] });

    expect(buildMutationReport(facts).report.survivors[0]?.covered).toBe(false);
  });

  it('joins a multi-line original and cuts a long one', () => {
    const source = `foo(\n  bar,\n${'z'.repeat(100)})`;

    const facts = factsOf(
      {
        'src/a.ts': [
          mutant({
            mutatorName: 'BlockStatement',
            replacement: '{}',
            location: { start: { line: 1, column: 1 }, end: { line: 3, column: 102 } },
          }),
        ],
      },
      { sources: { 'src/a.ts': source } },
    );

    expect(buildMutationReport(facts).report.survivors[0]?.original).toBe(
      `foo( bar, ${'z'.repeat(70)}...`,
    );
  });

  it('sorts survivors by path, line, and column and counts every status', () => {
    const facts = factsOf({
      'src/b.ts': [mutant({ status: 'Killed' }), mutant({ replacement: 'q' })],
      'src/a.ts': [
        mutant({ location: at(9, 1) }),
        mutant({ location: at(3, 5) }),
        mutant({ location: at(3, 1) }),
        mutant({ status: 'Timeout' }),
        mutant({ status: 'Ignored' }),
        mutant({ status: 'RuntimeError' }),
        mutant({ status: 'NoCoverage', location: at(4, 1) }),
      ],
    });

    const { report } = buildMutationReport(facts);

    expect(report.survivors.map(({ file, line, column }) => `${file}:${line}:${column}`)).toEqual([
      'src/a.ts:3:1',
      'src/a.ts:3:5',
      'src/a.ts:4:1',
      'src/a.ts:9:1',
      'src/b.ts:1:1',
    ]);

    expect(report.totals).toEqual({
      mutants: 8,
      killed: 1,
      survived: 4,
      noCoverage: 1,
      timeout: 1,
      invalid: 1,
      falseSurvived: 0,
    });
  });
});

const withTestCount = (facts: MutationFacts, count: number): MutationFacts => ({
  ...facts,
  stryker: {
    files: {},
    ...facts.stryker,
    testFiles: { 'a.test.ts': { tests: Array.from({ length: count }, () => ({})) } },
  },
});

describe('buildMutationReport with false survivors', () => {
  it('lists a static survivor that ran fewer tests than the report holds apart', () => {
    const facts = withTestCount(
      factsOf({ 'src/a.ts': [mutant({ static: true, testsCompleted: 0 })] }),
      3,
    );

    const { report, exitCode } = buildMutationReport(facts);

    expect(report.survivors).toEqual([]);
    expect(report.falseSurvivors).toHaveLength(1);
    expect(report.totals).toMatchObject({ mutants: 1, survived: 0, falseSurvived: 1 });
    expect(report.status).toBe('pass');
    expect(exitCode).toBe(0);
  });

  it.each([
    { testsCompleted: 2, survivors: 1, falseSurvivors: 0 },
    { testsCompleted: 0, survivors: 0, falseSurvivors: 1 },
  ])(
    'plans only the covering tests of a static survivor with ignoreStatic ($testsCompleted completed)',
    ({ testsCompleted, survivors, falseSurvivors }) => {
      const base = factsOf({
        'src/a.ts': [mutant({ static: true, coveredBy: ['1', '2'], testsCompleted })],
      });

      const facts = withTestCount(base, 5);

      facts.stryker = {
        ...facts.stryker,
        files: facts.stryker?.files ?? {},
        config: { ignoreStatic: true },
      };

      const { report } = buildMutationReport(facts);

      expect(report.survivors).toHaveLength(survivors);
      expect(report.falseSurvivors).toHaveLength(falseSurvivors);
    },
  );

  it('keeps a static survivor that ran every test as a survivor', () => {
    const facts = withTestCount(
      factsOf({ 'src/a.ts': [mutant({ static: true, testsCompleted: 3 })] }),
      3,
    );

    const { report } = buildMutationReport(facts);

    expect(report.survivors).toHaveLength(1);
    expect(report.falseSurvivors).toEqual([]);
    expect(report.totals.falseSurvived).toBe(0);
  });

  it('keeps a non-static survivor with a low test count as a survivor', () => {
    const facts = withTestCount(
      factsOf({ 'src/a.ts': [mutant({ static: false, testsCompleted: 0 })] }),
      3,
    );

    const { report } = buildMutationReport(facts);

    expect(report.survivors).toHaveLength(1);
    expect(report.falseSurvivors).toEqual([]);
  });

  it('keeps a static survivor when the report has no test files', () => {
    const facts = factsOf({ 'src/a.ts': [mutant({ static: true, testsCompleted: 0 })] });

    const { report } = buildMutationReport(facts);

    expect(report.survivors).toHaveLength(1);
    expect(report.falseSurvivors).toEqual([]);
  });

  it('keeps a static NoCoverage mutant as a survivor', () => {
    const facts = withTestCount(
      factsOf({ 'src/a.ts': [mutant({ status: 'NoCoverage', static: true, testsCompleted: 0 })] }),
      3,
    );

    const { report } = buildMutationReport(facts);

    expect(report.survivors).toHaveLength(1);
    expect(report.falseSurvivors).toEqual([]);
  });

  it('lists false survivors when the run failed', () => {
    const facts = withTestCount(
      factsOf({ 'src/a.ts': [mutant({ static: true, testsCompleted: 0 })] }, { error: 'boom' }),
      3,
    );

    const { report } = buildMutationReport(facts);

    expect(report.status).toBe('error');
    expect(report.falseSurvivors).toHaveLength(1);
  });
});

describe('buildMutationReport with a failed run', () => {
  it('keeps the error text in the report', () => {
    const { report } = buildMutationReport(
      factsOf({}, { stryker: undefined, error: 'Stryker exited with status 3.' }),
    );

    expect(report.error).toBe('Stryker exited with status 3.');
  });

  it('gives an error with the file count when files are unmutated', () => {
    const { report } = buildMutationReport(factsOf({}, { unmutated: ['src/a.ts'] }));

    expect(report.error).toContain('1 file(s)');
  });
});

describe('failedMutationReport', () => {
  it('reports the error with no mode when none was chosen', () => {
    const report = failedMutationReport(null, 'bad usage');

    expect(report).toMatchObject({
      mode: null,
      status: 'error',
      error: 'bad usage',
      falseSurvivors: [],
    });

    expect(report.totals.falseSurvived).toBe(0);
  });
});
