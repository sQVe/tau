import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { noUiContext } from '../../../tests/toolContext.js';
import { createStackCheckout, git } from './fixtures/checkout.js';
import { createStackFake } from './fixtures/stackFake.js';
import type { FakePull } from './fixtures/stackFake.js';
import { createStackTool } from './tool.js';
import type { StackInput } from './tool.js';

const containing = (text: string): unknown => expect.stringContaining(text);

const setUp = async () => {
  const root = await createStackCheckout(onTestFinished);
  const fake = createStackFake();

  await git(root, 'checkout', '--quiet', '-b', 'feature');
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'feature');
  await git(root, 'push', '--quiet', '-u', 'origin', 'feature');

  const run = async (input: StackInput) => {
    const result = await createStackTool(fake.exec).execute(
      'call',
      input,
      undefined,
      undefined,
      noUiContext(root),
    );

    return result.details;
  };

  return { root, fake, run };
};

const layer = (name: string, flags: Record<string, unknown> = {}) => ({
  name,
  base: 'b'.repeat(40),
  isCurrent: name === 'feature',
  isMerged: false,
  isQueued: false,
  needsRebase: false,
  pr: null,
  ...flags,
});

const pull = (overrides: Partial<FakePull> = {}): FakePull => ({
  number: 5,
  headBranch: 'feature',
  baseRefName: 'main',
  ...overrides,
});

const stackViewCalls = (calls: string[]) => calls.filter((call) => call.startsWith('stack '));

it('decides tracked from gh stack view and reads only the pull requests based on the branch', async () => {
  const { fake, run } = await setUp();

  fake.stackView = {
    code: 0,
    stdout: JSON.stringify({
      trunk: 'main',
      currentBranch: 'feature',
      branches: [layer('lower', { isMerged: true }), layer('feature')],
    }),
    stderr: '',
  };

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'tracked',
    branch: 'feature',
    trunk: 'main',
    parent: 'main',
    layers: [{ name: 'lower' }, { name: 'feature' }],
    evidence: { current: { rebasePaused: false }, github: null },
    basedOn: [],
  });

  expect(stackViewCalls(fake.calls)).toHaveLength(1);
  expect(fake.calls.filter((call) => call.startsWith('pr list'))).toHaveLength(1);
});

it('decides tracked from the gh stack 0.2.1 view output, which has no head and no pr', async () => {
  const { fake, run } = await setUp();
  const stdout = await readFile(new URL('./fixtures/ghStackView021.json', import.meta.url), 'utf8');

  fake.stackView = { code: 0, stdout, stderr: '' };

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'tracked',
    branch: 'feature',
    parent: 'parent',
    layers: [{ name: 'parent' }, { name: 'feature' }],
  });
});

it.each([
  {
    name: 'several stacks',
    view: { code: 6, stdout: '', stderr: 'several stacks' },
    reason: 'several stacks',
  },
  { name: 'a failed command', view: { code: 1, stdout: '', stderr: 'boom' }, reason: 'code 1' },
  { name: 'empty output', view: { code: 0, stdout: '', stderr: '' }, reason: 'cannot be read' },
  {
    name: 'malformed output',
    view: { code: 0, stdout: '{"trunk":1}', stderr: '' },
    reason: 'unexpected output',
  },
])('decides unknown for $name from gh stack view', async ({ view, reason }) => {
  const { fake, run } = await setUp();

  fake.stackView = view;

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({ result: 'unknown', reason: containing(reason) });
  expect(fake.calls).toEqual(['stack view --json']);
});

it('decides unknown, without running gh stack view, while a stack rebase is paused', async () => {
  const { root, fake, run } = await setUp();

  await writeFile(join(root, '.git', 'gh-stack-rebase-state'), '{}');

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'unknown',
    branch: 'feature',
    evidence: { current: { rebasePaused: true } },
  });

  expect(stackViewCalls(fake.calls)).toEqual([]);
});

it('decides unknown for a detached HEAD', async () => {
  const { root, fake, run } = await setUp();

  await git(root, 'checkout', '--quiet', '--detach');

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'unknown',
    reason: containing('HEAD is detached'),
    branch: null,
    evidence: { current: { rebasePaused: false }, resolved: null, github: null },
  });

  expect(fake.calls).toEqual(['stack view --json']);
});

it('decides standalone when GitHub shows no stack and nothing around the pull request', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull()];

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'standalone',
    evidence: { current: { stackView: { exitCode: 2 } }, github: { defaultBranch: 'main' } },
  });
});

it('decides standalone for a branch with no pull request', async () => {
  const { run } = await setUp();

  expect(await run({ action: 'check' })).toMatchObject({ result: 'standalone' });
});

it('decides standalone when stacked pull requests are off', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull()];
  fake.stackedPullRequestsOff = true;

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'standalone',
    evidence: { github: { stacks: { ok: true, value: { kind: 'off' } } } },
  });
});

it('decides untracked, with the GitHub stack, when GitHub holds the pull request', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [
    pull(),
    pull({ number: 4, headBranch: 'lower' }),
    pull({ number: 6, headBranch: 'upper', baseRefName: 'feature' }),
  ];

  fake.stacks[5] = [4, 5, 6];

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'untracked',
    held: ['githubStack', 'openPullBasedOnBranch'],
    githubStack: { number: 104, pullRequests: [4, 5, 6] },
    chain: [
      { branch: 'feature', number: 5 },
      { branch: 'upper', number: 6 },
    ],
  });
});

it('decides untracked when the base of the pull request has an open pull request', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull({ baseRefName: 'lower' }), pull({ number: 4, headBranch: 'lower' })];

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'untracked',
    held: ['baseHasOpenPull'],
    chain: [
      { branch: 'lower', number: 4 },
      { branch: 'feature', number: 5 },
    ],
    chainBase: 'main',
  });
});

it('ignores a pull request from another fork that uses the branch name', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull({ number: 9, headOwner: 'someone' })];

  expect(await run({ action: 'check' })).toMatchObject({ result: 'standalone' });
});

it('decides unknown for several open pull requests from the push repository', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull(), pull({ number: 8 })];

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({ result: 'unknown', reason: containing('#5, #8') });
});

it.each([
  {
    name: 'the head pull request list',
    prefix: 'pr list --repo github.com/sQVe/tau --head feature',
  },
  {
    name: 'the based-on pull request list',
    prefix: 'pr list --repo github.com/sQVe/tau --base feature',
  },
  { name: 'the stacks API', prefix: 'api' },
])('decides unknown when $name fails', async ({ prefix }) => {
  const { fake, run } = await setUp();

  fake.pulls = [pull()];
  fake.override(prefix, { code: 1, stderr: 'HTTP 500' });

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({ result: 'unknown', reason: containing('HTTP 500') });
});

it('decides unknown when a pull request list is malformed', async () => {
  const { fake, run } = await setUp();

  fake.override('pr list --repo github.com/sQVe/tau --head', { stdout: '{"oops":1}' });

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'unknown',
    reason: containing('unexpected output'),
  });
});

it('decides unknown when the stacks API prints something that is not a list of numbers', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull()];
  fake.override('api', { stdout: '' });

  expect(await run({ action: 'check' })).toMatchObject({ result: 'unknown' });
});

it.each([
  { name: 'a stack without pull_requests', stdout: '[{"number":17}]' },
  { name: 'a stack without a number', stdout: '[{"pull_requests":[]}]' },
  { name: 'null', stdout: 'null' },
  { name: 'a null stack', stdout: '[null]' },
])('decides unknown when the stacks API prints $name', async ({ stdout }) => {
  const { fake, run } = await setUp();

  fake.pulls = [pull()];
  fake.override('api', { stdout });

  expect(await run({ action: 'check' })).toMatchObject({
    result: 'unknown',
    reason: containing('cannot be read'),
  });
});

it('decides unknown when no remote has the branch to push to', async () => {
  const { root, run } = await setUp();

  await git(root, 'checkout', '--quiet', '-b', 'local-only');

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'unknown',
    reason: containing('local-only'),
  });
});

it('checks another branch with the GitHub reads only', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull(), pull({ number: 6, headBranch: 'child', baseRefName: 'feature' })];

  const details = await run({ action: 'check', branch: 'feature' });

  expect(details).toMatchObject({ result: 'untracked', held: ['openPullBasedOnBranch'] });

  const other = await run({ action: 'check', branch: 'other' });

  expect(other).toMatchObject({ branch: 'other' });
  expect(stackViewCalls(fake.calls)).toHaveLength(1);
});

it('does not run gh stack view for a branch that is not checked out, even while a rebase is paused', async () => {
  const { root, fake, run } = await setUp();

  await git(root, 'branch', 'parent');
  await git(root, 'push', '--quiet', 'origin', 'parent');
  await writeFile(join(root, '.git', 'gh-stack-rebase-state'), '{}');
  fake.pulls = [pull({ number: 3, headBranch: 'parent' })];

  const details = await run({ action: 'check', branch: 'parent' });

  expect(details).toMatchObject({ result: 'standalone', branch: 'parent' });
  expect(stackViewCalls(fake.calls)).toEqual([]);
});

it('decides untracked for a parent that another open pull request is based on', async () => {
  const { root, fake, run } = await setUp();

  await git(root, 'branch', 'parent');
  await git(root, 'push', '--quiet', 'origin', 'parent');

  fake.pulls = [
    pull({ number: 3, headBranch: 'parent' }),
    pull({ number: 4, headBranch: 'sibling', baseRefName: 'parent' }),
  ];

  const details = await run({ action: 'check', branch: 'parent' });

  expect(details).toMatchObject({
    result: 'untracked',
    held: ['openPullBasedOnBranch'],
    chain: [
      { branch: 'parent', number: 3 },
      { branch: 'sibling', number: 4 },
    ],
  });
});

it('runs no gh command that writes', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull()];

  await run({ action: 'check' });
  await run({ action: 'check', branch: 'feature' });

  const writes = fake.calls.filter((call) =>
    /^stack (add|init|rebase|push|sync|link|checkout)/u.test(call),
  );

  expect(writes).toEqual([]);
});

it('returns the open pull requests based on a tracked current branch that its local stack lacks', async () => {
  const { fake, run } = await setUp();

  fake.stackView = {
    code: 0,
    stdout: JSON.stringify({
      trunk: 'main',
      currentBranch: 'feature',
      branches: [layer('feature')],
    }),
    stderr: '',
  };

  fake.pulls = [pull(), pull({ number: 6, headBranch: 'child', baseRefName: 'feature' })];

  const details = await run({ action: 'check', branch: 'feature' });

  expect(details).toMatchObject({
    result: 'tracked',
    basedOn: [{ branch: 'child', number: 6 }],
  });
});

it('decides unknown for a tracked branch when the based-on read fails', async () => {
  const { fake, run } = await setUp();

  fake.stackView = {
    code: 0,
    stdout: JSON.stringify({
      trunk: 'main',
      currentBranch: 'feature',
      branches: [layer('feature')],
    }),
    stderr: '',
  };

  fake.override('pr list --repo github.com/sQVe/tau --base feature', {
    code: 1,
    stderr: 'HTTP 500',
  });

  expect(await run({ action: 'check' })).toMatchObject({
    result: 'unknown',
    reason: containing('HTTP 500'),
  });
});

it('reads GitHub for the named branch, not for a local branch below it', async () => {
  const { root, fake, run } = await setUp();

  await git(root, 'push', '--quiet', 'origin', 'feature:refs/heads/parent');
  await git(root, 'branch', 'parent/child', 'feature');
  await git(root, 'config', 'branch.parent/child.remote', 'origin');
  await git(root, 'config', 'branch.parent/child.merge', 'refs/heads/parent/child');
  fake.pulls = [pull({ number: 6, headBranch: 'sibling', baseRefName: 'parent' })];

  const details = await run({ action: 'check', branch: 'parent' });

  expect(details).toMatchObject({ branch: 'parent', result: 'untracked' });
  expect(fake.calls.some((call) => call.includes('--head parent/child'))).toBe(false);
  expect(fake.calls.some((call) => call.includes('--head parent '))).toBe(true);
});

it('refuses an empty remote name', async () => {
  const { run } = await setUp();

  expect(await run({ action: 'check', remote: '' })).toMatchObject({
    result: 'unknown',
    reason: containing('remote must not be empty'),
  });
});

it('decides unknown, with the failed read as evidence, when another branch has no push target', async () => {
  const { fake, run } = await setUp();

  const details = await run({ action: 'check', branch: 'elsewhere', remote: '' });

  expect(details).toMatchObject({
    result: 'unknown',
    branch: 'elsewhere',
    evidence: { current: null, resolved: { ok: false }, github: null },
  });

  expect(fake.calls).toEqual([]);
});

it('decides unknown, with the failed read as evidence, when a tracked branch has no push target', async () => {
  const { fake, run } = await setUp();

  fake.stackView = {
    code: 0,
    stdout: JSON.stringify({
      trunk: 'main',
      currentBranch: 'feature',
      branches: [layer('feature')],
    }),
    stderr: '',
  };

  const details = await run({ action: 'check', remote: '' });

  expect(details).toMatchObject({
    result: 'unknown',
    branch: 'feature',
    evidence: { current: { rebasePaused: false }, resolved: { ok: false }, github: null },
  });
});

it('decides unknown, with the failed read as evidence, when a tracked branch cannot list its dependents', async () => {
  const { fake, run } = await setUp();

  fake.stackView = {
    code: 0,
    stdout: JSON.stringify({
      trunk: 'main',
      currentBranch: 'feature',
      branches: [layer('feature')],
    }),
    stderr: '',
  };

  fake.override('pr list --repo github.com/sQVe/tau --base feature', {
    code: 1,
    stderr: 'HTTP 500',
  });

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'unknown',
    reason: containing('HTTP 500'),
    branch: 'feature',
    evidence: { resolved: { ok: true }, github: null, basedOn: { ok: false } },
  });
});

it('decides unknown when the call is cancelled before gh answers', async () => {
  const { root, fake } = await setUp();
  const controller = new AbortController();

  fake.pulls = [pull()];
  controller.abort();

  const result = await createStackTool(fake.exec).execute(
    'call',
    { action: 'check' },
    controller.signal,
    undefined,
    noUiContext(root),
  );

  expect(result.details).toMatchObject({
    result: 'unknown',
    branch: 'feature',
    evidence: { current: { stackView: { exitCode: null } } },
  });
});

it('decides unknown with no branch for a detached HEAD during a paused rebase', async () => {
  const { root, run } = await setUp();

  await git(root, 'checkout', '--quiet', '--detach');
  await writeFile(join(root, '.git', 'gh-stack-rebase-state'), '{}');

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'unknown',
    branch: null,
    evidence: { current: { rebasePaused: true } },
  });
});

const basedOnList = (count: number) =>
  JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      number: 100 + index,
      url: `https://github.com/sQVe/tau/pull/${100 + index}`,
      headRefName: `above-${index}`,
    })),
  );

it('decides unknown when the pull request list may have been cut off at its limit', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull()];
  fake.override('pr list --repo github.com/sQVe/tau --base feature', { stdout: basedOnList(100) });

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({
    result: 'unknown',
    reason: containing('may be incomplete'),
  });
});

it('reads a pull request list one short of its limit as complete', async () => {
  const { fake, run } = await setUp();

  fake.pulls = [pull()];
  fake.override('pr list --repo github.com/sQVe/tau --base feature', { stdout: basedOnList(99) });

  const details = await run({ action: 'check' });

  expect(details).toMatchObject({ result: 'untracked', held: ['openPullBasedOnBranch'] });
});
