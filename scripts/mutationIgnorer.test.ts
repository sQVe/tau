import { Instrumenter } from '@stryker-mutator/instrumenter';
import { noopLogger } from '@stryker-mutator/util';
import { describe, expect, it } from 'vitest';

import { mutationIgnorer } from './mutationIgnorer.ts';
import { buildMutationReport } from './mutationReport.ts';

const instrument = async (content: string) => {
  const result = await new Instrumenter(noopLogger).instrument(
    [{ name: 'fixture.ts', content, mutate: true }],
    { plugins: null, excludedMutations: [], ignorers: [mutationIgnorer] },
  );

  return result.mutants;
};

const stringMutants = async (content: string) => {
  const mutants = await instrument(content);

  return mutants.filter(({ mutatorName }) => mutatorName === 'StringLiteral');
};

describe('mutationIgnorer', () => {
  it.each([
    { name: 'an Error message', source: "throw new Error('x');" },
    { name: 'a custom error message', source: "throw new ParseError('x');" },
    { name: 'an AggregateError message', source: "new AggregateError(errors, 'x');" },
    { name: 'an invariant message', source: "invariant(cond, 'x');" },
    { name: 'an invariant template message', source: 'invariant(cond, `x`);' },
    { name: 'the error of a failed result', source: "const value = { ok: false, error: 'x' };" },
  ])('skips $name', async ({ source }) => {
    const mutants = await stringMutants(source);

    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants.every(({ status }) => status === 'Ignored')).toBe(true);
  });

  it('keeps the mutants inside the expression of a template message', async () => {
    const source = `throw new Error(\`bad \${flag ? 'a' : 'b'}\`);`;
    const mutants = await instrument(source);

    expect(mutants.length).toBeGreaterThan(0);
    expect(mutants.every(({ status }) => status !== 'Ignored')).toBe(true);
  });

  it.each([
    { name: 'a plain object value', source: "const value = { label: 'x' };" },
    { name: 'the error of a passing result', source: "const value = { ok: true, error: 'x' };" },
    { name: 'the condition of an invariant', source: "invariant('x', 'y');" },
    { name: 'a call argument', source: "report('x');" },
    { name: 'a custom error with a second string', source: "new TaskFormatError('retired', 'x');" },
    { name: 'an AggregateError errors list', source: "new AggregateError('x');" },
    { name: 'a class that is not an error', source: "new Thing('x');" },
  ])('keeps a string mutant in $name', async ({ source }) => {
    const mutants = await stringMutants(source);

    expect(mutants.some(({ status }) => status !== 'Ignored')).toBe(true);
  });

  it('keeps both strings of a custom error with two arguments', async () => {
    const mutants = await stringMutants("new TaskFormatError('retired', 'x');");

    expect(mutants).toHaveLength(2);
    expect(mutants.every(({ status }) => status !== 'Ignored')).toBe(true);
  });

  it('leaves a disabled mutator off the report and keeps the others on that line', async () => {
    const mutants = await instrument(
      [
        'const check = (a: number) => {',
        '  // Stryker disable next-line ConditionalExpression: equivalent mutant',
        '  return a > 1 ? 2 : 3;',
        '};',
      ].join('\n'),
    );

    const reported = mutants.map(({ mutatorName, replacement, location, status }) => ({
      mutatorName,
      replacement,
      // The instrumenter counts lines from 0; Stryker's report counts from 1.
      location: {
        start: { line: location.start.line + 1, column: location.start.column + 1 },
        end: { line: location.end.line + 1, column: location.end.column + 1 },
      },
      status: status === 'Ignored' ? 'Ignored' : 'Survived',
    }));

    const { report } = buildMutationReport({
      mode: 'audit',
      stryker: { files: { 'fixture.ts': { mutants: reported } } },
      sources: {},
      unmutated: [],
    });

    const mutators = report.survivors.map(({ mutator, line }) => ({ mutator, line }));

    const others = mutators.filter(({ mutator }) => mutator !== 'ConditionalExpression');

    expect(mutators.length).toBe(others.length);
    expect(others.some(({ line }) => line === 3)).toBe(true);
  });
});
