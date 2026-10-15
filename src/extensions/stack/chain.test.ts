import { expect, it } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import { createStackFake } from './fixtures/stackFake.js';
import type { FakePull } from './fixtures/stackFake.js';
import { createStackTool } from './tool.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const url = (number: number) => `https://github.com/sQVe/tau/pull/${number}`;

const pull = (number: number, overrides: Partial<FakePull> = {}): FakePull => ({
  number,
  headBranch: `slice-${number}`,
  baseRefName: 'main',
  ...overrides,
});

const setUp = () => {
  const fake = createStackFake();

  const run = async (pullRequests: string[], slicePullRequest?: string) => {
    const result = await createStackTool(fake.exec).execute(
      'call',
      {
        action: 'chain',
        pullRequests,
        ...(slicePullRequest === undefined ? {} : { slicePullRequest }),
      },
      undefined,
      undefined,
      noUiContext(process.cwd()),
    );

    return result.details;
  };

  return { fake, run };
};

it('takes the only open blocker as the parent and the default branch as the trunk', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(3)];
  fake.defaultBranch = 'trunk';

  const details = await run([url(3)]);

  expect(details).toMatchObject({
    repository: 'github.com/sQVe/tau',
    decision: {
      result: 'parent',
      parent: { number: 3, url: url(3), branch: 'slice-3' },
      branchAbove: false,
      githubStack: null,
      trunk: 'trunk',
    },
  });
});

it('takes the highest blocker of one GitHub stack, with the trunk from its bottom pull request', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2, { baseRefName: 'release' }), pull(3, { baseRefName: 'slice-2' })];
  fake.stacks = { 2: [2, 3], 3: [2, 3] };

  const details = await run([url(2), url(3)]);

  expect(details).toMatchObject({
    decision: {
      result: 'parent',
      parent: { number: 3 },
      branchAbove: false,
      githubStack: { number: 102, pullRequests: [2, 3], topBranch: 'slice-3', topPullRequest: 3 },
      trunk: 'release',
    },
  });
});

it('finds a branch above the parent in its GitHub stack', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(3, { baseRefName: 'slice-2' }), pull(4, { baseRefName: 'slice-3' })];
  fake.stacks = { 2: [2, 3, 4], 3: [2, 3, 4] };

  const details = await run([url(2), url(3)]);

  expect(details).toMatchObject({
    decision: {
      parent: { number: 3 },
      branchAbove: true,
      above: [4],
      githubStack: { topBranch: 'slice-4', topPullRequest: 4 },
    },
  });
});

it('does not count the slice pull request as a branch above the parent', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(8, { baseRefName: 'slice-2' })];
  fake.stacks = { 2: [2, 8] };

  const details = await run([url(2)], url(8));

  expect(details).toMatchObject({ decision: { branchAbove: false, above: [] } });
});

it('finds a branch above the parent from another open pull request based on it', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(9, { baseRefName: 'slice-2' })];
  fake.stacks = { 2: [2] };

  const details = await run([url(2)], url(8));

  expect(details).toMatchObject({ decision: { branchAbove: true, above: [9] } });
});

it('stops when a pull request is based on the parent and no stack holds the parent', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(9, { baseRefName: 'slice-2' })];

  const details = await run([url(2)]);

  expect(details).toMatchObject({
    decision: { result: 'stop', reason: containing('#9') },
  });
});

it.each([
  { name: 'different stacks', stacks: { 2: [1, 2], 5: [5, 6] } },
  { name: 'no stack', stacks: {} },
])('stops when two open blockers sit in $name', async ({ stacks }) => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(5)];
  fake.stacks = stacks;

  expect(await run([url(2), url(5)])).toMatchObject({ decision: { result: 'stop' } });
});

it('stops when stacked pull requests are off and several blockers are open', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(5)];
  fake.stackedPullRequestsOff = true;

  expect(await run([url(2), url(5)])).toMatchObject({ decision: { result: 'stop' } });
});

it('takes the only blocker when stacked pull requests are off', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2)];
  fake.stackedPullRequestsOff = true;

  expect(await run([url(2)])).toMatchObject({ decision: { result: 'parent', githubStack: null } });
});

it.each([
  {
    name: 'a pull request that cannot be viewed',
    prefix: 'pr view 2',
    result: { code: 1, stderr: 'boom' },
  },
  {
    name: 'a pull request view with malformed output',
    prefix: 'pr view 2',
    result: { stdout: '[]' },
  },
  { name: 'a stacks API failure', prefix: 'api', result: { code: 1, stderr: 'HTTP 500' } },
  { name: 'empty stacks API output', prefix: 'api', result: { stdout: '' } },
  { name: 'a null stacks reply', prefix: 'api', result: { stdout: 'null' } },
  { name: 'a null stack', prefix: 'api', result: { stdout: '[null]' } },
  {
    name: 'a stack without a number',
    prefix: 'api',
    result: { stdout: '[{"pull_requests":[]}]' },
  },
  {
    name: 'a stack without a pull request list',
    prefix: 'api',
    result: { stdout: '[{"number":17}]' },
  },
  { name: 'malformed stacks API output', prefix: 'api', result: { stdout: '{"a":1}' } },
])('stops on $name, with the failed read as evidence', async ({ prefix, result }) => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2)];
  fake.override(prefix, result);

  const details = await run([url(2)]);

  expect(details).toMatchObject({ decision: { result: 'stop' } });
  expect(JSON.stringify(details)).toContain('"ok":false');
});

it('stops when the default branch cannot be read', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2)];
  fake.override('repo view', { code: 1, stderr: 'boom' });

  expect(await run([url(2)])).toMatchObject({ decision: { result: 'stop' } });
});

it('stops for a blocker that is no longer open', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2, { state: 'MERGED' })];

  expect(await run([url(2)])).toMatchObject({ decision: { result: 'stop' } });
});

it('counts a repeated blocker once', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2)];

  expect(await run([url(2), url(2)])).toMatchObject({
    decision: { result: 'parent', parent: { number: 2 } },
  });
});

it.each([
  { name: 'no blockers', input: [], error: 'at least one' },
  {
    name: 'a URL that is not a pull request',
    input: ['https://github.com/sQVe/tau/issues/2'],
    error: 'not a pull request URL',
  },
  {
    name: 'pull requests of two repositories',
    input: [url(2), 'https://github.com/other/tau/pull/3'],
    error: 'one repository',
  },
])('refuses $name', async ({ input, error }) => {
  const { run } = setUp();

  await expect(run(input)).rejects.toThrow(error);
});

it('refuses a slice pull request of another repository', async () => {
  const { run } = setUp();

  await expect(run([url(2)], 'https://github.com/other/tau/pull/3')).rejects.toThrow(
    'one repository',
  );
});

it('runs no gh command that writes', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(3)];
  fake.stacks = { 2: [2, 3], 3: [2, 3] };

  await run([url(2), url(3)]);

  expect(fake.calls.filter((call) => !/^(pr (view|list)|api|repo view)/u.test(call))).toEqual([]);
});

it('treats URLs that differ only in the case of the owner and name as one repository', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(3, { baseRefName: 'slice-2' })];
  fake.stacks = { 2: [2, 3], 3: [2, 3] };

  const details = await run(
    [url(2), 'https://github.com/SQVE/Tau/pull/3'],
    'https://github.com/sqve/TAU/pull/8',
  );

  expect(details).toMatchObject({ decision: { result: 'parent', parent: { number: 3 } } });
});
