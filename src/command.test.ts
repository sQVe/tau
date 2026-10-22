import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { checkOutput, outputPreviewLength, parseJson } from './command.js';

it('returns the value of valid JSON', () => {
  expect(parseJson('tool list', '{"a":[1]}')).toEqual({ a: [1] });
});

it('names the label and the start of output that is not JSON', () => {
  const stdout = `oops${'x'.repeat(outputPreviewLength)}`;
  let thrown: unknown;

  try {
    parseJson('tool list', stdout);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({
    message: `tool list printed output that is not JSON: ${stdout.slice(0, outputPreviewLength)}`,
    cause: expect.any(SyntaxError) as unknown,
  });
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
  }).toThrow(/^tool list printed unexpected output: .*name/u);
});
