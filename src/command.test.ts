import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { checkOutput, parseJson } from './command.js';

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
