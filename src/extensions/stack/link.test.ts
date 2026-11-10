import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { withoutField } from '../../../tests/withoutField.js';
import { createStackCheckout } from './fixtures/checkout.js';
import { createStackFake, joinedCalls } from './fixtures/stackFake.js';
import { createStackTool } from './tool.js';

const containing = (text: string): unknown => expect.stringContaining(text);
const anyReason: unknown = expect.any(String);
const anyEvidence: unknown = expect.any(Object);

const setUp = async () => {
  const root = await createStackCheckout(onTestFinished);
  const fake = createStackFake();

  await git(root, 'checkout', '--quiet', '-b', 'upper');

  fake.pulls = [
    { number: 2, headBranch: 'lower', baseRefName: 'main' },
    { number: 3, headBranch: 'upper', baseRefName: 'lower' },
  ];

  const view = {
    trunk: 'main',
    currentBranch: 'upper',
    branches: fake.pulls.map((pull) => ({
      name: pull.headBranch,
      base: pull.baseRefName,
      isCurrent: pull.number === 3,
      isMerged: false,
      isQueued: false,
      needsRebase: false,
      pr: {
        number: pull.number,
        state: 'OPEN',
        url: `https://github.com/sQVe/tau/pull/${pull.number}`,
      },
    })),
  };

  fake.stackView = { code: 0, stderr: '', stdout: JSON.stringify(view) };

  const run = async () => {
    const result = await createStackTool(fake.exec).execute(
      'call',
      { action: 'link', pr: 3, remote: 'origin' },
      undefined,
      undefined,
      noUiContext(root),
    );

    return result.details;
  };

  return { fake, root, run, view };
};

it('plans a new GitHub stack from two open local pull requests', async () => {
  const { fake, run } = await setUp();

  expect(await run()).toMatchObject({
    result: 'command',
    command: 'gh stack link --remote origin --base main 2 3',
  });

  expect(
    joinedCalls(fake).filter((call) => !/^(stack view|pr view|api|repo view)/u.test(call)),
  ).toEqual([]);
});

it('reads PRs by branch when local tracking has no PR numbers', async () => {
  const { fake, run, view } = await setUp();
  const branches = view.branches.map((branch) => withoutField(branch, 'pr'));

  fake.stackView.stdout = JSON.stringify({ ...view, branches });

  expect(await run()).toMatchObject({
    result: 'command',
    command: 'gh stack link --remote origin --base main 2 3',
  });
});

it('plans appending to the GitHub stack below', async () => {
  const { fake, run } = await setUp();

  fake.stacks = { 2: [2] };

  expect(await run()).toMatchObject({
    result: 'command',
    command: 'gh stack link --remote origin 102 3',
  });
});

it('checks a completed append before refusing another top below', async () => {
  const { fake, run } = await setUp();

  fake.stacks = { 2: [2, 3], 3: [2, 3] };

  expect(await run()).toMatchObject({ result: 'linked' });
});

it('needs no link for one open PR', async () => {
  const { fake, run } = await setUp();

  fake.pulls[0] = { number: 2, headBranch: 'lower', baseRefName: 'main', state: 'MERGED' };

  expect(await run()).toMatchObject({ result: 'none' });
});

it('stops with a reason when the PR branch is in no local stack', async () => {
  const { fake, run } = await setUp();

  fake.pulls[1] = { number: 3, headBranch: 'outside', baseRefName: 'main' };

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: containing('no local stack'),
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack link'))).toEqual([]);
});

it.each([
  { name: 'missing local stack', key: 'stack view', failure: 'no stack' },
  { name: 'malformed local stack', key: 'stack view', output: '{}' },
  { name: 'missing target PR', key: 'pr view 3', failure: 'not found' },
  { name: 'malformed target PR', key: 'pr view 3', output: '{}' },
  { name: 'missing lower PR', key: 'pr view 2', failure: 'not found' },
  { name: 'malformed lower PR', key: 'pr view 2', output: '{}' },
  { name: 'failed stacks API', key: 'api', failure: 'HTTP 500' },
  { name: 'malformed stacks API', key: 'api', output: '{}' },
  { name: 'failed repository read', key: 'repo view', failure: 'not found' },
  { name: 'malformed repository read', key: 'repo view', output: '{}' },
])('stops on $name without writing', async ({ key, output, failure }) => {
  const { fake, run } = await setUp();

  if (failure === undefined) {
    fake.overrideOutput(key, output);
  } else {
    fake.failCommand(key, failure);
  }

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: anyReason,
    evidence: anyEvidence,
  });

  expect(
    joinedCalls(fake).filter((call) => !/^(stack view|pr view|api|repo view)/u.test(call)),
  ).toEqual([]);
});

it('stops when stacked pull requests are off', async () => {
  const { fake, run } = await setUp();

  fake.stackedPullRequestsOff = true;

  expect(await run()).toMatchObject({ result: 'stop', reason: containing('off') });
});

it('reads PRs and stacks from the base repository of a fork', async () => {
  const { fake, run } = await setUp();

  fake.overrideOutput(
    'repo view',
    JSON.stringify({
      isFork: true,
      parent: { owner: { login: 'upstream' }, name: 'project' },
      defaultBranchRef: { name: 'main' },
    }),
  );

  expect(await run()).toMatchObject({ result: 'command' });

  const calls = joinedCalls(fake);

  expect(
    calls
      .filter((call) => call.startsWith('pr view'))
      .every((call) => call.includes('--repo github.com/upstream/project')),
  ).toBe(true);

  expect(calls.filter((call) => call.startsWith('api'))).toEqual([
    'api --hostname github.com repos/upstream/project/stacks?pull_request=3',
    'api --hostname github.com repos/upstream/project/stacks?pull_request=2',
  ]);
});

it('stops when the requested remote cannot resolve', async () => {
  const { root, run } = await setUp();

  await git(root, 'remote', 'remove', 'origin');

  expect(await run()).toMatchObject({ result: 'stop', reason: containing('origin') });
});
