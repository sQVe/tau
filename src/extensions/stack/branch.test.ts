import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../../tests/gitRepository.js';
import { createBranch } from './branch.js';
import { createStackCheckout } from './fixtures/checkout.js';
import { createStackFake, joinedCalls } from './fixtures/stackFake.js';

const containing = (value: string): unknown => expect.stringContaining(value);

it('creates from a parent in no stack with an explicit fetch and init', async () => {
  const root = await createStackCheckout(onTestFinished);
  const fake = createStackFake();

  fake.trackBranches(root, []);

  await git(root, 'branch', 'parent');
  await git(root, 'push', '--quiet', 'origin', 'parent');
  await git(root, 'branch', '-D', 'parent');
  await git(root, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  await git(root, 'update-ref', '-d', 'refs/remotes/origin/parent');

  const result = await createBranch(
    { cwd: root, exec: fake.exec },
    { parent: 'parent', branch: 'child', trunk: 'main', remote: 'origin' },
  );

  expect(result).toEqual({
    result: 'created',
    writes: [
      'gh stack checkout parent',
      'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
      'git switch --no-track -c parent origin/parent',
      'gh stack init --base main parent child',
    ],
  });

  expect(joinedCalls(fake)).toContain('stack init --base main parent child');
  expect(await git(root, 'branch', '--show-current')).toBe('child');
  expect(await git(root, 'rev-parse', 'child')).toBe(await git(root, 'rev-parse', 'origin/parent'));
});

const setUp = async (branches: string[]) => {
  const root = await createStackCheckout(onTestFinished);
  const fake = createStackFake();

  await git(root, 'branch', 'parent');
  await git(root, 'push', '--quiet', 'origin', 'parent');
  fake.trackBranches(root, branches);

  const run = () =>
    createBranch(
      { cwd: root, exec: fake.exec },
      { parent: 'parent', branch: 'child', trunk: 'main', remote: 'origin' },
    );

  return { root, fake, run };
};

it('creates in a parent stack after fetching and fast-forwarding', async () => {
  const { root, fake, run } = await setUp(['parent']);
  const oldParent = await git(root, 'rev-parse', 'parent');

  await git(root, 'switch', 'parent');
  await git(root, 'commit', '--allow-empty', '-m', 'remote change');
  await git(root, 'push', '--quiet', 'origin', 'parent');
  const remoteTip = await git(root, 'rev-parse', 'parent');

  await git(root, 'switch', 'main');
  await git(root, 'branch', '-f', 'parent', oldParent);

  expect(await run()).toEqual({
    result: 'created',
    writes: [
      'gh stack checkout parent',
      'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
      'git merge --ff-only origin/parent',
      'gh stack add child',
    ],
  });

  expect(await git(root, 'rev-parse', 'parent')).toBe(remoteTip);
  expect(await git(root, 'rev-parse', 'child')).toBe(remoteTip);
  expect(joinedCalls(fake)).toContain('stack add child');
});

it('finds an existing branch in place and repeats the final check', async () => {
  const { root, fake, run } = await setUp(['parent', 'child']);

  await git(root, 'branch', 'child');

  expect(await run()).toEqual({ result: 'inPlace', writes: ['gh stack checkout child'] });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout child',
    'stack view --json',
    'stack view --json',
  ]);

  expect(await git(root, 'branch', '--show-current')).toBe('child');
});

it('accepts a child imported by the parent checkout and repeats the final check', async () => {
  const { root, fake, run } = await setUp(['parent', 'child']);
  const execute = fake.exec;

  fake.exec = async (command, commandArguments, options) => {
    const result = await execute(command, commandArguments, options);

    if (commandArguments.join(' ') === 'stack checkout parent') {
      await git(root, 'branch', 'child', 'parent');
    }

    return result;
  };

  expect(await run()).toEqual({
    result: 'inPlace',
    writes: [
      'gh stack checkout parent',
      'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
    ],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout parent',
    'stack view --json',
    'stack view --json',
  ]);

  expect(await git(root, 'rev-parse', 'child')).toBe(await git(root, 'rev-parse', 'parent'));
});

it('stops before writes when the parent check is unknown', async () => {
  const { root, fake, run } = await setUp([]);

  fake.failCommand('pr list --base', 'cannot read parent PRs');

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: containing('cannot read parent PRs'),
    writes: [],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([]);
  expect(await git(root, 'branch', '--show-current')).toBe('main');
  expect(await git(root, 'branch', '--list', 'child')).toBe('');
});

it.each([
  { name: 'a parent stack', branches: ['parent'], command: 'stack add child' },
  { name: 'no parent stack', branches: [], command: 'stack init --base main parent child' },
])('adopts an existing branch without rebasing in $name', async ({ branches, command }) => {
  const { root, fake, run } = await setUp(branches);

  await git(root, 'switch', '-c', 'child');
  await git(root, 'commit', '--allow-empty', '-m', 'existing work');
  const childTip = await git(root, 'rev-parse', 'child');

  await git(root, 'switch', 'main');

  expect(await run()).toMatchObject({ result: 'created' });
  expect(joinedCalls(fake)).toContain(command);
  expect(await git(root, 'rev-parse', 'child')).toBe(childTip);
  expect(await git(root, 'branch', '--show-current')).toBe('child');
});

it('keeps earlier writes when the final stack view is malformed', async () => {
  const { root, fake, run } = await setUp([]);

  fake.overrideOutput('stack view', '{}');

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: containing('gh stack view --json'),
    writes: [
      'gh stack checkout parent',
      'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
      'git switch parent',
      'gh stack init --base main parent child',
    ],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout parent',
    'stack init --base main parent child',
    'stack view --json',
  ]);

  expect(await git(root, 'branch', '--show-current')).toBe('child');
  expect(await git(root, 'rev-parse', 'child')).toBe(await git(root, 'rev-parse', 'parent'));
});

it('stops after a failed checkout without attempting another write', async () => {
  const { root, fake, run } = await setUp([]);

  fake.failCommand('stack checkout', 'checkout refused');

  expect(await run()).toEqual({
    result: 'stop',
    reason: 'gh stack checkout parent exited with code 1: checkout refused',
    writes: ['gh stack checkout parent'],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout parent',
  ]);

  expect(await git(root, 'branch', '--show-current')).toBe('main');
  expect(await git(root, 'branch', '--list', 'child')).toBe('');
});

it('stops when fast-forwarding a diverged parent fails', async () => {
  const { root, fake, run } = await setUp(['parent']);

  await git(root, 'switch', 'parent');
  await git(root, 'commit', '--allow-empty', '-m', 'remote change');
  await git(root, 'push', '--quiet', 'origin', 'parent');
  await git(root, 'switch', 'main');
  await git(root, 'branch', '-f', 'parent', 'main');
  await git(root, 'switch', 'parent');
  await git(root, 'commit', '--allow-empty', '-m', 'local change');
  const parentTip = await git(root, 'rev-parse', 'parent');

  await git(root, 'switch', 'main');

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: containing('git merge --ff-only origin/parent'),
    writes: [
      'gh stack checkout parent',
      'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
      'git merge --ff-only origin/parent',
    ],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout parent',
  ]);

  expect(await git(root, 'rev-parse', 'parent')).toBe(parentTip);
  expect(await git(root, 'branch', '--list', 'child')).toBe('');
});

it('stops without adding a branch when the parent is ahead of its remote', async () => {
  const { root, fake, run } = await setUp(['parent']);

  await git(root, 'switch', 'parent');
  await git(root, 'commit', '--allow-empty', '-m', 'local change');
  const parentTip = await git(root, 'rev-parse', 'parent');

  await git(root, 'switch', 'main');

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: containing('ahead'),
    writes: [
      'gh stack checkout parent',
      'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
    ],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout parent',
  ]);

  expect(await git(root, 'rev-parse', 'parent')).toBe(parentTip);
  expect(await git(root, 'branch', '--list', 'child')).toBe('');
});

it.each([
  { name: 'add', branches: ['parent'], command: 'stack add child', key: 'stack add' },
  {
    name: 'init',
    branches: [],
    command: 'stack init --base main parent child',
    key: 'stack init',
  },
])('stops after a failed $name with the writes made so far', async ({ branches, command, key }) => {
  const { root, fake, run } = await setUp(branches);

  fake.failCommand(key, 'write refused');

  const writes = [
    'gh stack checkout parent',
    'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
  ];

  const stackCalls = ['stack checkout parent'];

  if (branches.length === 0) {
    writes.push('git switch parent');
  } else {
    stackCalls.push('stack view --json');
  }

  writes.push(`gh ${command}`);
  stackCalls.push(command);

  expect(await run()).toEqual({
    result: 'stop',
    reason: `gh ${command} exited with code 1: write refused`,
    writes,
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual(stackCalls);
  expect(await git(root, 'branch', '--show-current')).toBe('parent');
  expect(await git(root, 'branch', '--list', 'child')).toBe('');
});

it('stops on an existing branch checkout failure before checking out the parent', async () => {
  const { root, fake, run } = await setUp(['parent', 'child']);

  await git(root, 'branch', 'child');
  fake.failCommand('stack checkout', 'existing checkout refused');

  expect(await run()).toEqual({
    result: 'stop',
    reason: 'gh stack checkout child exited with code 1: existing checkout refused',
    writes: ['gh stack checkout child'],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout child',
  ]);

  expect(await git(root, 'branch', '--show-current')).toBe('main');
});

it('stops on an existing branch view failure without creating on the parent', async () => {
  const { root, fake, run } = await setUp(['parent', 'child']);

  await git(root, 'branch', 'child');
  fake.overrideOutput('stack view', '{}');

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: containing('gh stack view --json'),
    writes: ['gh stack checkout child'],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout child',
    'stack view --json',
  ]);

  expect(await git(root, 'branch', '--show-current')).toBe('child');
});

it('stops when the fast-forward history read fails before reading ahead history', async () => {
  const { root, fake, run } = await setUp(['parent']);

  await git(root, 'config', 'log.showSignature', 'invalid');

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: containing('git log --oneline refs/heads/parent..refs/remotes/origin/parent --'),
    writes: [
      'gh stack checkout parent',
      'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
    ],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout parent',
  ]);

  expect(await git(root, 'branch', '--list', 'child')).toBe('');
});

it('stops when checking local branch existence fails instead of treating it as present', async () => {
  const { root, fake, run } = await setUp([]);
  const execute = fake.exec;
  const packedRefs = join(root, '.git', 'packed-refs');

  fake.exec = async (command, commandArguments, options) => {
    const result = await execute(command, commandArguments, options);

    if (commandArguments.includes('--base')) {
      await writeFile(packedRefs, 'invalid packed reference\n');
    }

    return result;
  };

  const result = await run();

  await rm(packedRefs);

  expect(result).toMatchObject({
    result: 'stop',
    reason: containing('git rev-parse --verify --quiet refs/heads/child'),
    writes: [],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([]);
  expect(await git(root, 'branch', '--show-current')).toBe('main');
  expect(await git(root, 'branch', '--list', 'child')).toBe('');
});

it('reads the parent stack after checkout instead of trusting its GitHub check', async () => {
  const { root, fake, run } = await setUp(['parent', 'above']);

  expect(await run()).toMatchObject({
    result: 'stop',
    reason: containing('above parent'),
    writes: [
      'gh stack checkout parent',
      'git fetch origin refs/heads/parent:refs/remotes/origin/parent',
    ],
  });

  expect(joinedCalls(fake).filter((call) => call.startsWith('stack '))).toEqual([
    'stack checkout parent',
    'stack view --json',
  ]);

  expect(await git(root, 'branch', '--show-current')).toBe('parent');
  expect(await git(root, 'branch', '--list', 'child')).toBe('');
});
