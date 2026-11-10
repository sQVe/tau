import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { createLinearFake } from '../../../tests/linearFake.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createStartSliceTool } from './startTool.js';
import { createSliceTool } from './tool.js';

const setUp = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const origin = await createTemporaryRepository(onTestFinished);

  await git(origin, 'commit', '--allow-empty', '-m', 'Initial');
  await git(root, 'remote', 'add', 'origin', origin);

  const fake = createLinearFake();
  const tool = createStartSliceTool(fake.exec);

  const read = (pick: string) =>
    tool.execute(
      'call',
      { action: 'read', pick, agentTeam: 'AI' },
      undefined,
      undefined,
      noUiContext(root),
    );

  return { root, fake, tool, read };
};

it('picks the first ready child and reads the remote default branch', async () => {
  const { root, fake, read } = await setUp();
  fake.addIssue({ identifier: 'ME-1', title: 'Container' });

  fake.addIssue({
    identifier: 'AI-1',
    title: 'Agent',
    parent: 'ME-1',
    teamId: 'team-ai',
    sortOrder: 0,
  });

  fake.addIssue({ identifier: 'ME-3', title: 'Later', parent: 'ME-1', sortOrder: 3 });

  fake.addIssue({
    identifier: 'ME-2',
    title: 'Ready',
    parent: 'ME-1',
    sortOrder: 2,
    branchName: 'me-2-ready',
  });

  fake.addIssue({
    identifier: 'ME-0',
    title: 'Merged',
    parent: 'ME-1',
    sortOrder: 1,
    pullRequests: ['https://github.com/me/repo/pull/1'],
  });

  fake.mergedPullRequests.add('https://github.com/me/repo/pull/1');

  const result = await read('ME-1');

  expect(result.details).toMatchObject({
    pick: {
      chosen: { identifier: 'ME-2', branchName: 'me-2-ready' },
      defaultBranch: 'main',
      base: 'origin/main',
      slices: [
        { identifier: 'ME-0', status: 'merged' },
        { identifier: 'ME-2', status: 'ready' },
        { identifier: 'ME-3', status: 'ready' },
      ],
    },
  });

  expect(await git(root, 'rev-parse', 'origin/main')).toMatch(/^[a-f0-9]{40}$/u);
  expect(fake.writes()).toEqual([]);
});

it('returns the open blocker URL and the named slice links', async () => {
  const { root, fake, read } = await setUp();
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');

  fake.addIssue({
    identifier: 'ME-1',
    title: 'Slice',
    blockedBy: ['ME-2'],
    pullRequests: ['https://github.com/me/repo/pull/1'],
  });

  fake.addIssue({
    identifier: 'ME-2',
    title: 'Blocker',
    pullRequests: ['https://github.com/me/repo/pull/2'],
  });

  const result = await read('ME-1');

  expect(result.details).toMatchObject({
    pick: {
      chosen: { identifier: 'ME-1', pullRequests: ['https://github.com/me/repo/pull/1'] },
      base: null,
      openBlockerPullRequests: ['https://github.com/me/repo/pull/2'],
      slices: [
        {
          blockers: [
            {
              identifier: 'ME-2',
              state: 'open',
              pullRequests: ['https://github.com/me/repo/pull/2'],
            },
          ],
        },
      ],
    },
  });

  expect(fake.calls.filter((call) => call.command === 'gh')).toHaveLength(2);
  expect(fake.writes()).toEqual([]);
});

it('reads a shared attachment PR only once', async () => {
  const { fake, read } = await setUp();
  const pullRequest = 'https://github.com/me/repo/pull/1';

  fake.addIssue({
    identifier: 'ME-1',
    title: 'Slice',
    pullRequests: [pullRequest],
    blockedBy: ['ME-2'],
  });

  fake.addIssue({ identifier: 'ME-2', title: 'Blocker', pullRequests: [pullRequest] });

  const result = await read('ME-1');

  expect(result.details).toMatchObject({
    pick: { chosen: { identifier: 'ME-1' }, openBlockerPullRequests: [pullRequest] },
  });

  expect(fake.calls.filter((call) => call.command === 'gh')).toHaveLength(1);
});

it('rejects pick on apply without writing', async () => {
  const { root, fake, tool } = await setUp();

  await expect(
    tool.execute(
      'call',
      { action: 'apply', pick: 'ME-1', agentTeam: 'AI' },
      undefined,
      undefined,
      noUiContext(root),
    ),
  ).rejects.toThrow('pick is only supported for read');

  expect(fake.writes()).toEqual([]);
});

it('returns both the pick and draft read when directory is given', async () => {
  const { root, fake, tool } = await setUp();
  const context = noUiContext(root);
  fake.addIssue({ identifier: 'ME-1', title: 'Slice' });

  const prepared = await createSliceTool(fake.exec).execute(
    'prepare',
    { action: 'prepare', id: 'me-1' },
    undefined,
    undefined,
    context,
  );

  const { directory } = prepared.details;

  const result = await tool.execute(
    'read',
    { action: 'read', pick: 'ME-1', directory, agentTeam: 'AI' },
    undefined,
    undefined,
    context,
  );

  expect(result.details).toMatchObject({
    directory,
    start: null,
    writes: [],

    pick: { chosen: { identifier: 'ME-1' } },
  });

  const stateToken = 'stateToken' in result.details ? result.details.stateToken : undefined;

  expect(stateToken).toEqual(expect.any(String));
  expect(fake.writes()).toEqual([]);
});

it.each(['read', 'apply'] as const)('requires directory for %s without pick', async (action) => {
  const { root, fake, tool } = await setUp();

  await expect(
    tool.execute('call', { action, agentTeam: 'AI' }, undefined, undefined, noUiContext(root)),
  ).rejects.toThrow('requires directory');

  expect(fake.calls).toEqual([]);
});

it('reports a blocked slice and its closed PR URL', async () => {
  const { fake, read } = await setUp();
  const pullRequest = 'https://github.com/me/repo/pull/2';
  fake.addIssue({ identifier: 'ME-1', title: 'Slice', blockedBy: ['ME-2'] });
  fake.addIssue({ identifier: 'ME-2', title: 'Blocker', pullRequests: [pullRequest] });
  fake.overrideOutput('pr view', '{"state":"CLOSED"}');

  const result = await read('ME-1');

  expect(result.details).toMatchObject({
    pick: {
      chosen: null,
      slices: [
        {
          status: 'blocked',
          blockers: [{ identifier: 'ME-2', state: 'other', pullRequests: [pullRequest] }],
        },
      ],
    },
  });

  expect(fake.writes()).toEqual([]);
});

it.each(['api', 'pr view'])(
  'fails when %s fails instead of guessing readiness',
  async (command) => {
    const { fake, read } = await setUp();

    fake.addIssue({
      identifier: 'ME-1',
      title: 'Slice',
      pullRequests: ['https://github.com/me/repo/pull/1'],
    });

    fake.failCall(command, 'network error');

    await expect(read('ME-1')).rejects.toThrow('network error');
    expect(fake.writes()).toEqual([]);
  },
);

it('fails when origin cannot be fetched', async () => {
  const { root, fake, read } = await setUp();
  fake.addIssue({ identifier: 'ME-1', title: 'Slice' });
  await git(root, 'remote', 'remove', 'origin');

  await expect(read('ME-1')).rejects.toThrow(
    'git fetch origin +refs/heads/*:refs/remotes/origin/* failed',
  );

  expect(fake.writes()).toEqual([]);
});

it('fails on a missing slice without writing', async () => {
  const { fake, read } = await setUp();

  await expect(read('ME-404')).rejects.toThrow('ME-404');
  expect(fake.writes()).toEqual([]);
});

it('fails on malformed Linear output without writing', async () => {
  const { fake, read } = await setUp();
  fake.overrideOutput('api', '{}');

  await expect(read('ME-1')).rejects.toThrow('linear');
  expect(fake.writes()).toEqual([]);
});
