import { expect, it } from 'vitest';

import { argumentAfter, createExecFake, succeededResult } from '../../../tests/execFake.js';
import type { ExecHandler } from '../../../tests/execFake.js';
import { runHistory } from './historyAction.js';

const firstPullRequest = 'https://github.com/sqve/tau/pull/562';
const secondPullRequest = 'https://github.com/sqve/tau/pull/563';
const firstRoot = '/repository/tau';
const secondRoot = '/repository/other';

const viewOutput = (comment: string) =>
  JSON.stringify({
    reviews: [{ author: { login: 'reviewer' }, state: 'APPROVED', body: comment }],
    comments: [{ author: { login: 'author' }, body: comment }],
  });

const inlineOutput = (comment: string) =>
  JSON.stringify([[{ user: { login: 'reviewer' }, body: comment }]]);

const createHistoryExec = (handlers: Readonly<Record<string, ExecHandler>>) =>
  createExecFake<string>({
    keyOf: (command, commandArguments) => {
      if (command === 'git') {
        return `git ${argumentAfter(commandArguments, '-C') ?? ''}`;
      }

      if (command === 'gh' && commandArguments[0] === 'pr') {
        return `view ${commandArguments[2] ?? ''}`;
      }

      if (command === 'gh' && commandArguments[0] === 'api') {
        return `inline ${commandArguments[1] ?? ''}`;
      }

      return undefined;
    },
    handlerFor: (key) => handlers[key],
  });

it('runs one revert log and two pull request reads', async () => {
  const fake = createHistoryExec({
    [`git ${firstRoot}`]: () => succeededResult('abc123\tRevert "Add a check"\n'),
    [`view ${firstPullRequest}`]: () => succeededResult(viewOutput('Looks good.')),
    'inline repos/sqve/tau/pulls/562/comments': () =>
      succeededResult(inlineOutput('Use the helper.')),
  });

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    { action: 'history', projectRoots: [firstRoot], pullRequests: [firstPullRequest] },
  );

  expect(result).toEqual({
    reverts: [{ projectRoot: firstRoot, commit: 'abc123', subject: 'Revert "Add a check"' }],
    reviews: [
      {
        url: firstPullRequest,
        author: 'reviewer',
        state: 'APPROVED',
        body: 'Looks good.',
      },
    ],
    comments: [
      { url: firstPullRequest, author: 'author', body: 'Looks good.' },
      { url: firstPullRequest, author: 'reviewer', body: 'Use the helper.' },
    ],
    coverage: 'complete',
    gaps: [],
  });

  expect(fake.calls.map((call) => [call.command, call.commandArguments])).toEqual([
    ['git', ['-C', firstRoot, 'log', '--since=30.days', '--grep=Revert', '--format=%H%x09%s']],
    ['gh', ['pr', 'view', firstPullRequest, '--json', 'reviews,comments']],
    ['gh', ['api', 'repos/sqve/tau/pulls/562/comments', '--paginate', '--slurp']],
  ]);
});

it('reads inline comments from every page', async () => {
  const fake = createHistoryExec({
    [`git ${firstRoot}`]: () => succeededResult(''),
    [`view ${firstPullRequest}`]: () =>
      succeededResult(JSON.stringify({ reviews: [], comments: [] })),
    'inline repos/sqve/tau/pulls/562/comments': () =>
      succeededResult(
        JSON.stringify([
          [{ user: { login: 'first' }, body: 'First page.' }],
          [{ user: { login: 'second' }, body: 'Second page.' }],
        ]),
      ),
  });

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    { action: 'history', projectRoots: [firstRoot], pullRequests: [firstPullRequest] },
  );

  expect(result.comments).toEqual([
    { url: firstPullRequest, author: 'first', body: 'First page.' },
    { url: firstPullRequest, author: 'second', body: 'Second page.' },
  ]);

  const inlineCall = fake.calls.find((call) => call.commandArguments[0] === 'api');

  expect(inlineCall?.commandArguments).toEqual([
    'api',
    'repos/sqve/tau/pulls/562/comments',
    '--paginate',
    '--slurp',
  ]);
});

it('reports invalid JSON without dropping a valid source', async () => {
  const fake = createHistoryExec({
    [`git ${firstRoot}`]: () => succeededResult('abc123\tRevert "Kept"\n'),
    [`view ${firstPullRequest}`]: () => succeededResult('not json'),
    'inline repos/sqve/tau/pulls/562/comments': () => succeededResult(inlineOutput('Kept inline.')),
  });

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    { action: 'history', projectRoots: [firstRoot], pullRequests: [firstPullRequest] },
  );

  expect(result.reverts).toHaveLength(1);

  expect(result.comments).toEqual([
    { url: firstPullRequest, author: 'reviewer', body: 'Kept inline.' },
  ]);

  expect(result.gaps.map((entry) => entry.source)).toEqual([firstPullRequest]);
  expect(result.gaps[0]?.reason).toContain('not JSON');
  expect(result.coverage).toBe('partial');
});

it('reports an invalid review shape without dropping a valid source', async () => {
  const fake = createHistoryExec({
    [`git ${firstRoot}`]: () => succeededResult('abc123\tRevert "Kept"\n'),
    [`view ${firstPullRequest}`]: () =>
      succeededResult(
        JSON.stringify({ reviews: [{ author: { login: 'reviewer' }, state: 'APPROVED' }] }),
      ),
    'inline repos/sqve/tau/pulls/562/comments': () => succeededResult(inlineOutput('Kept inline.')),
  });

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    { action: 'history', projectRoots: [firstRoot], pullRequests: [firstPullRequest] },
  );

  expect(result.reverts).toHaveLength(1);

  expect(result.comments).toEqual([
    { url: firstPullRequest, author: 'reviewer', body: 'Kept inline.' },
  ]);

  expect(result.gaps.map((entry) => entry.source)).toEqual([firstPullRequest]);
  expect(result.gaps[0]?.reason).toContain('unexpected output');
  expect(result.coverage).toBe('partial');
});

it('reports an invalid comment shape without dropping a valid source', async () => {
  const fake = createHistoryExec({
    [`git ${firstRoot}`]: () => succeededResult('abc123\tRevert "Kept"\n'),
    [`view ${firstPullRequest}`]: () =>
      succeededResult(JSON.stringify({ reviews: [], comments: [] })),
    'inline repos/sqve/tau/pulls/562/comments': () =>
      succeededResult(JSON.stringify([[{ user: { login: 'reviewer' } }]])),
    [`view ${secondPullRequest}`]: () => succeededResult(viewOutput('Still read.')),
    'inline repos/sqve/tau/pulls/563/comments': () => succeededResult(inlineOutput('Also read.')),
  });

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    {
      action: 'history',
      projectRoots: [firstRoot],
      pullRequests: [firstPullRequest, secondPullRequest],
    },
  );

  expect(result.reverts).toHaveLength(1);

  expect(result.comments).toEqual([
    { url: secondPullRequest, author: 'author', body: 'Still read.' },
    { url: secondPullRequest, author: 'reviewer', body: 'Also read.' },
  ]);

  expect(result.gaps.map((entry) => entry.source)).toEqual([firstPullRequest]);
  expect(result.gaps[0]?.reason).toContain('unexpected output');
  expect(result.coverage).toBe('partial');
});

it('reports a malformed revert line without dropping a valid source', async () => {
  const fake = createHistoryExec({
    [`git ${firstRoot}`]: () => succeededResult('not a revert line\n'),
    [`git ${secondRoot}`]: () => succeededResult('def456\tRevert "Kept"\n'),
    [`view ${firstPullRequest}`]: () => succeededResult(viewOutput('Still read.')),
    'inline repos/sqve/tau/pulls/562/comments': () => succeededResult(inlineOutput('Also read.')),
  });

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    {
      action: 'history',
      projectRoots: [firstRoot, secondRoot],
      pullRequests: [firstPullRequest],
    },
  );

  expect(result.reverts).toEqual([
    { projectRoot: secondRoot, commit: 'def456', subject: 'Revert "Kept"' },
  ]);

  expect(result.comments).toHaveLength(2);
  expect(result.gaps.map((entry) => entry.source)).toEqual([firstRoot]);
  expect(result.gaps[0]?.reason).toContain('unexpected output');
  expect(result.coverage).toBe('partial');
});

it('continues after a failed root and a failed pull request', async () => {
  const fake = createHistoryExec({
    [`git ${secondRoot}`]: () => succeededResult('def456\tRevert "Drop it"\n'),
    [`view ${secondPullRequest}`]: () => succeededResult(viewOutput('Still read.')),
    'inline repos/sqve/tau/pulls/563/comments': () => succeededResult(inlineOutput('Also read.')),
  });

  fake.failCommand(`git ${firstRoot}`, 'not a git repository');
  fake.failCommand(`view ${firstPullRequest}`, 'could not resolve to a pull request');
  fake.failCommand('inline repos/sqve/tau/pulls/562/comments', 'not found');

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    {
      action: 'history',
      projectRoots: [firstRoot, secondRoot],
      pullRequests: [firstPullRequest, secondPullRequest],
    },
  );

  expect(result).toMatchObject({
    reverts: [{ projectRoot: secondRoot, commit: 'def456', subject: 'Revert "Drop it"' }],
    reviews: [{ url: secondPullRequest, author: 'reviewer', state: 'APPROVED' }],
    comments: [
      { url: secondPullRequest, author: 'author', body: 'Still read.' },
      { url: secondPullRequest, author: 'reviewer', body: 'Also read.' },
    ],
    coverage: 'partial',
  });

  expect(result.gaps.map((entry) => entry.source)).toEqual([
    firstRoot,
    firstPullRequest,
    firstPullRequest,
  ]);
});

it('reports unknown coverage when every read fails', async () => {
  const fake = createHistoryExec({});

  fake.failCommand(`git ${firstRoot}`, 'not a git repository');
  fake.failCommand(`view ${firstPullRequest}`, 'could not resolve to a pull request');
  fake.failCommand('inline repos/sqve/tau/pulls/562/comments', 'not found');

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    { action: 'history', projectRoots: [firstRoot], pullRequests: [firstPullRequest] },
  );

  expect(result).toMatchObject({
    reverts: [],
    reviews: [],
    comments: [],
    coverage: 'unknown',
  });

  expect(result.gaps).toHaveLength(3);
});

it('reports a cap without reading the extra source', async () => {
  const roots = Array.from({ length: 11 }, (_, index) => `/repository/${index + 1}`);

  const handlerEntries = roots
    .slice(0, 10)
    .map((root) => [`git ${root}`, () => succeededResult('')] as const);

  const handlers = Object.fromEntries(handlerEntries);

  const fake = createHistoryExec(handlers);

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    { action: 'history', projectRoots: roots, pullRequests: [] },
  );

  expect(result).toMatchObject({
    coverage: 'partial',
    gaps: [{ source: 'projectRoots', reason: 'capped at 10' }],
  });

  expect(fake.calls).toHaveLength(10);
});

it('passes an aborted signal to every command', async () => {
  const controller = new AbortController();

  const fake = createHistoryExec({
    [`git ${firstRoot}`]: () => succeededResult(''),
  });

  await runHistory(
    { exec: fake.exec, cwd: '/work/tau', signal: controller.signal },
    { action: 'history', projectRoots: [firstRoot], pullRequests: [] },
  );

  expect(fake.calls.map((call) => call.signal)).toEqual([controller.signal]);
});

it('returns an empty result when no source is requested', async () => {
  const fake = createHistoryExec({});

  const result = await runHistory(
    { exec: fake.exec, cwd: '/work/tau' },
    { action: 'history', projectRoots: [], pullRequests: [] },
  );

  expect(result).toEqual({
    reverts: [],
    reviews: [],
    comments: [],
    coverage: 'unknown',
    gaps: [],
  });

  expect(fake.calls).toEqual([]);
});
