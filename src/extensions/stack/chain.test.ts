import { expect, it } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import { withoutField } from '../../../tests/withoutField.js';
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

it('stops when only a later blocker sits in a GitHub stack', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2), pull(5), pull(6, { baseRefName: 'slice-5' })];
  fake.stacks = { 5: [5, 6] };

  const details = await run([url(2), url(5)]);

  expect(details).toMatchObject({
    decision: { result: 'stop', reason: containing('different GitHub stacks') },
  });
});

it.each([
  { name: 'bottom', stack: [2, 3], viewed: 'pr view 2 ', blocker: 3 },
  { name: 'top', stack: [3, 4], viewed: 'pr view 4 ', blocker: 3 },
])('stops when the $name pull request of the stack cannot be viewed', async (scenario) => {
  const { fake, run } = setUp();
  const { stack, viewed, blocker } = scenario;

  fake.pulls = [pull(2), pull(3, { baseRefName: 'slice-2' }), pull(4, { baseRefName: 'slice-3' })];
  fake.stacks = { [blocker]: stack };
  fake.override(viewed, { code: 1, stderr: 'boom' });

  const details = await run([url(blocker)]);

  expect(details).toMatchObject({
    decision: { result: 'stop', reason: containing(viewed.trim()) },
  });
});

it('returns the blockers and the facts it decided from as evidence', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(3)];

  const details = await run([url(3)]);

  expect(details).toMatchObject({
    evidence: {
      blockers: [{ number: 3, url: url(3), view: { ok: true } }],
      facts: { parent: { number: 3 }, slicePullRequest: null },
    },
  });
});

it('returns the blockers and no facts when it stops before the parent', async () => {
  const { fake, run } = setUp();

  fake.pulls = [pull(3, { state: 'MERGED' })];

  const details = await run([url(3)]);

  expect(details).toMatchObject({
    decision: { result: 'stop' },
    evidence: { blockers: [{ number: 3 }], facts: null },
  });
});

it.each([
  { name: 'text before the URL', input: `see ${url(3)}` },
  { name: 'a pull request number with letters after it', input: `${url(3)}x` },
  { name: 'a path that does not follow the number', input: `${url(3)}files` },
])('refuses $name', async ({ input }) => {
  const { fake, run } = setUp();

  await expect(run([input])).rejects.toThrow('not a pull request URL');
  expect(fake.calls).toEqual([]);
});

it.each([
  { name: 'spaces around the URL', input: `  ${url(3)}  ` },
  { name: 'a path after the number', input: `${url(3)}/files` },
  { name: 'a query after the number', input: `${url(3)}?diff=split` },
])('accepts $name', async ({ input }) => {
  const { fake, run } = setUp();

  fake.pulls = [pull(3)];

  expect(await run([input])).toMatchObject({
    decision: { result: 'parent', parent: { number: 3 } },
  });
});

it('stops when the call is cancelled before gh answers', async () => {
  const { fake } = setUp();
  const controller = new AbortController();

  fake.pulls = [pull(3)];
  controller.abort();

  const result = await createStackTool(fake.exec).execute(
    'call',
    { action: 'chain', pullRequests: [url(3)] },
    controller.signal,
    undefined,
    noUiContext(process.cwd()),
  );

  expect(result.details).toMatchObject({ decision: { result: 'stop' } });
});

const viewEntry = { number: 2, headRefName: 'slice-2', baseRefName: 'main', state: 'OPEN' };

const viewKeys = Object.keys(viewEntry);

const missingViewFields = viewKeys.map((key) => ({
  name: `no ${key}`,
  output: withoutField(viewEntry, key),
}));

const malformedViewOutputs = [
  ...missingViewFields,
  { name: 'a fractional number', output: { ...viewEntry, number: 1.5 } },
];

it.each(malformedViewOutputs)('stops on a pull request view with $name', async ({ output }) => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2)];
  fake.override('pr view 2', { stdout: JSON.stringify(output) });

  expect(await run([url(2)])).toMatchObject({
    decision: { result: 'stop', reason: containing('unexpected output') },
  });
});

it.each([
  { name: 'no default branch reference', output: {} },
  { name: 'a default branch reference without a name', output: { defaultBranchRef: {} } },
])('stops on a repository view with $name', async ({ output }) => {
  const { fake, run } = setUp();

  fake.pulls = [pull(2)];
  fake.override('repo view', { stdout: JSON.stringify(output) });

  expect(await run([url(2)])).toMatchObject({
    decision: { result: 'stop', reason: containing('unexpected output') },
  });
});
