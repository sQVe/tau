import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import { createStackFake } from './fixtures/stackFake.js';
import { createStackTool } from './tool.js';

const { parameters } = createStackTool(createStackFake().exec);
const containing = (text: string): unknown => expect.stringContaining(text);

it.each(['check', 'history', 'chain', 'link'])('accepts the action %s', (action) => {
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
  { name: 'a fractional PR number', input: { action: 'link', pr: 1.5, remote: 'origin' } },
  { name: 'a nonpositive PR number', input: { action: 'link', pr: 0, remote: 'origin' } },
  { name: 'a text PR number', input: { action: 'link', pr: '3', remote: 'origin' } },
  { name: 'a start tip that is not text', input: { action: 'history', startTips: { a: 1 } } },
])('refuses $name', ({ input }) => {
  expect(Value.Check(parameters, input)).toBe(false);
});

it('routes link to a read-only local stack check', async () => {
  const fake = createStackFake();
  const tool = createStackTool(fake.exec);

  const result = await tool.execute(
    'call',
    { action: 'link', pr: 3, remote: 'origin' },
    undefined,
    undefined,
    noUiContext(process.cwd()),
  );

  expect(result.details).toMatchObject({
    result: 'stop',
    reason: containing('local stack'),
  });

  expect(fake.calls.map((call) => call.commandArguments)).toEqual([['stack', 'view', '--json']]);
});

it.each([
  { name: 'remote', input: { action: 'link' as const, pr: 3 } },
  { name: 'pr', input: { action: 'link' as const, remote: 'origin' } },
])('requires link input $name before reading', async ({ name, input }) => {
  const fake = createStackFake();
  const tool = createStackTool(fake.exec);

  await expect(
    tool.execute('call', input, undefined, undefined, noUiContext(process.cwd())),
  ).rejects.toThrow(`link needs ${name}`);

  expect(fake.calls).toEqual([]);
});
