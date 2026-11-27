import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { checkOutput, commandFailure, parseJson } from './command.js';

const failedResult = (overrides: Record<string, unknown>) =>
  ({ code: 1, killed: false, stdout: '', stderr: '', ...overrides }) as never;

it('falls back to stdout when stderr is whitespace only', () => {
  const failure = commandFailure('herdr-app do', failedResult({ stderr: ' \n', stdout: 'boom' }));

  expect(failure?.message).toBe('herdr-app do failed: boom');
});

it('names the exit status when a failed command printed nothing', () => {
  const failure = commandFailure('herdr-app do', failedResult({ code: 3 }));

  expect(failure?.message).toBe('herdr-app do failed: exit code 3');
});

it('names a killed command that printed nothing', () => {
  const failure = commandFailure('herdr-app do', failedResult({ killed: true }));

  expect(failure?.message).toBe('herdr-app do failed: killed');
});

it('returns the value of valid JSON', () => {
  expect(parseJson('tool list', '{"a":[1]}')).toEqual({ a: [1] });
});

it('names the label and a cut start of output that is not JSON, and keeps the parse error', () => {
  const stdout = `oops${'x'.repeat(10_000)}END`;
  let thrown: unknown;

  try {
    parseJson('tool list', stdout);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const { message, cause } = thrown as Error;

  expect(message).toContain('tool list');
  expect(message).toContain('oops');
  expect(message).not.toContain('END');
  expect(cause).toBeInstanceOf(SyntaxError);
});

it('accepts a value that matches the schema', () => {
  const schema = Type.Object({ name: Type.String() });

  expect(() => {
    checkOutput('tool list', schema, { name: 'a' });
  }).not.toThrow();
});

it('names the label and the first failing field of a value that breaks the schema', () => {
  const schema = Type.Object({ name: Type.String() });

  expect(() => {
    checkOutput('tool list', schema, { name: 1 });
  }).toThrow(/tool list.*\/name/u);
});
