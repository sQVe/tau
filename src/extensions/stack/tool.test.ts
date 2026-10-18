import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import { createStackFake } from './fixtures/stackFake.js';
import { createStackTool } from './tool.js';

const { parameters } = createStackTool(createStackFake().exec);

it.each(['check', 'history', 'chain'])('accepts the action %s', (action) => {
  expect(Value.Check(parameters, { action })).toBe(true);
});

it.each([
  { name: 'an unknown action', input: { action: 'rebase' } },
  { name: 'no action', input: {} },
  {
    name: 'a pull request list that holds a number',
    input: { action: 'chain', pullRequests: [1] },
  },
  { name: 'a branch that is not text', input: { action: 'check', branch: 7 } },
  { name: 'a start tip that is not text', input: { action: 'history', startTips: { a: 1 } } },
])('refuses $name', ({ input }) => {
  expect(Value.Check(parameters, input)).toBe(false);
});
