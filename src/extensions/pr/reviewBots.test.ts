import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createGhFake } from './fixtures/ghFake.js';
import type { FakePullRequest } from './fixtures/ghFake.js';
import { createPrTool } from './tool.js';
import type { PrInput } from './tool.js';

const repository = 'github.com/sQVe/tau';
const bot = { login: 'chatgpt-codex-connector', comment: '@codex review' };
const config = { reviews: { repositories: { 'sQVe/tau': { bots: [bot] } } } };
const requestedAt = '2026-10-14T10:05:00Z';

const pullRequest = (overrides: Partial<FakePullRequest> = {}): FakePullRequest => ({
  number: 7,
  state: 'OPEN',
  title: 'Add a feature',
  body: 'Adds it.',
  baseRefName: 'main',
  isDraft: false,
  headRefOid: 'abc123',
  headOwner: 'sQVe',
  headBranch: 'feature',
  ...overrides,
});

const setUp = async (userConfig?: unknown) => {
  const root = await createTemporaryRepository(onTestFinished);
  const agentDirectory = await mkdtemp(join(tmpdir(), 'tau-review-bots-'));
  const fake = createGhFake();
  const notices: string[] = [];

  onTestFinished(() => rm(agentDirectory, { recursive: true, force: true }));

  if (userConfig !== undefined) {
    await writeFile(join(agentDirectory, 'tau.json'), JSON.stringify(userConfig));
  }

  const context = {
    cwd: root,
    isProjectTrusted: () => true,
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionToolContext;

  const run = async (input: Record<string, unknown> = {}) => {
    const tool = createPrTool(fake.exec, { agentDirectory });
    const parameters = { action: 'reviewBots', repository, pr: 7, ...input } as PrInput;
    const result = await tool.execute('call', parameters, undefined, undefined, context);

    return result.details;
  };

  fake.pullRequests[repository] = [pullRequest()];

  return { root, fake, notices, run };
};

it('asks for the bot that has not reviewed or been asked', async () => {
  const { run, fake } = await setUp(config);

  await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'request' }] });

  expect(fake.calls.map(({ commandArguments }) => commandArguments.slice(0, 3))).toEqual([
    ['pr', 'view', '7'],
    ['api', '--hostname', 'github.com'],
  ]);
});

it('skips a bot that reviewed the head', async () => {
  const { run, fake } = await setUp(config);

  fake.pullRequests[repository] = [
    pullRequest({ reviews: [{ login: bot.login, commit: 'abc123' }] }),
  ];

  await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'reviewed' }] });
});

it('asks again after a push that came after a review of an older head', async () => {
  const { run, fake } = await setUp(config);

  fake.pullRequests[repository] = [
    pullRequest({
      reviews: [{ login: bot.login, commit: 'old000' }],
      comments: [{ body: bot.comment, createdAt: '2026-10-14T09:00:00Z' }],
    }),
  ];

  await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'request' }] });
});

it('skips a bot whose request came after the head commit', async () => {
  const { run, fake } = await setUp(config);

  fake.pullRequests[repository] = [
    pullRequest({ comments: [{ body: bot.comment, createdAt: requestedAt }] }),
  ];

  await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'requested' }] });
});

it.each([
  { condition: 'the user file is missing', user: undefined },
  { condition: 'reviews is not set', user: { qa: {} } },
  { condition: 'the repository has no entry', user: { reviews: { repositories: {} } } },
  {
    condition: 'the entry lists no bot',
    user: { reviews: { repositories: { 'sQVe/tau': { bots: [] } } } },
  },
  {
    condition: 'another repository has a bad entry',
    user: { reviews: { repositories: { 'sQVe/cape': { bots: 'x' } } } },
  },
])('requests no bot and reads no pull request when $condition', async ({ user }) => {
  const { run, fake } = await setUp(user);

  await expect(run()).resolves.toEqual({ bots: [] });
  expect(fake.calls).toEqual([]);
});

it('warns once about an unknown key and ignores it', async () => {
  const { run, notices } = await setUp({
    reviews: { repositories: { 'sQVe/tau': { bots: [bot] } }, extra: 1 },
  });

  await run();
  await run();

  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('reviews.extra');
});

it.each([
  { condition: 'reviews is not an object', reviews: 'on', error: 'reviews must be an object' },
  {
    condition: 'repositories is a list',
    reviews: { repositories: [] },
    error: 'keyed by owner/name',
  },
  {
    condition: 'the entry is not an object',
    reviews: { repositories: { 'sQVe/tau': 'x' } },
    error: 'reviews.repositories.sQVe/tau must be an object',
  },
  {
    condition: 'bots is missing',
    reviews: { repositories: { 'sQVe/tau': {} } },
    error: 'bots must be a list of bots',
  },
  {
    condition: 'a bot has no login',
    reviews: { repositories: { 'sQVe/tau': { bots: [{ comment: 'x' }] } } },
    error: 'bots[0].login must be a string',
  },
  {
    condition: 'a bot comment is empty',
    reviews: { repositories: { 'sQVe/tau': { bots: [{ login: 'a', comment: ' ' }] } } },
    error: 'bots[0].comment is empty',
  },
  {
    condition: 'two bots share a login',
    reviews: {
      repositories: {
        'sQVe/tau': { bots: [bot, { ...bot, login: 'CHATGPT-codex-connector[bot]' }] },
      },
    },
    error: 'lists CHATGPT-codex-connector[bot] twice',
  },
  {
    condition: 'two keys differ only in case',
    reviews: { repositories: { 'sQVe/tau': { bots: [bot] }, 'sqve/tau': { bots: [bot] } } },
    error: 'name the same repository',
  },
])('refuses a bad config when $condition', async ({ reviews, error }) => {
  const { run, fake } = await setUp({ reviews });

  await expect(run()).rejects.toThrow(error);
  expect(fake.calls).toEqual([]);
});

it('refuses a repository file that sets reviews', async () => {
  const { run, root } = await setUp(config);

  await mkdir(join(root, '.pi'));
  await writeFile(join(root, '.pi', 'tau.json'), JSON.stringify(config));

  await expect(run()).rejects.toThrow('reviews may be set only in the user file');
});

it.each([
  {
    condition: 'repository is missing',
    input: { repository: undefined },
    error: 'needs repository',
  },
  { condition: 'pr is missing', input: { pr: undefined }, error: 'needs pr' },
  { condition: 'pr is below 1', input: { pr: 0 }, error: 'pr must be an integer of 1 or more' },
  {
    condition: 'repository is malformed',
    input: { repository: 'tau' },
    error: 'repository must be',
  },
])('refuses a request when $condition', async ({ input, error }) => {
  const { run, fake } = await setUp(config);

  await expect(run(input)).rejects.toThrow(error);
  expect(fake.calls).toEqual([]);
});

it('fails when gh pr view fails', async () => {
  const { run, fake } = await setUp(config);

  fake.failCommand('pr view');

  await expect(run()).rejects.toThrow('gh pr view');
});

it.each([
  { condition: 'is not JSON', output: 'nope' },
  {
    condition: 'lacks the reviews',
    output: JSON.stringify({ headRefOid: 'a', commits: [], comments: [] }),
  },
  {
    condition: 'has a comment without a date',
    output: JSON.stringify({
      headRefOid: 'a',
      commits: [],
      reviews: [],
      comments: [{ body: 'x' }],
    }),
  },
])('fails when the gh output $condition', async ({ output }) => {
  const { run, fake } = await setUp(config);

  fake.overrideOutput('pr view', output);

  await expect(run()).rejects.toThrow(/^gh pr view 7 /u);
});

it('reads the head date when the commit list does not hold the head', async () => {
  const { run, fake } = await setUp(config);

  fake.pullRequests[repository] = [
    pullRequest({ comments: [{ body: bot.comment, createdAt: requestedAt }] }),
  ];

  await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'requested' }] });
  expect(fake.calls.map(({ commandArguments }) => commandArguments[0])).toEqual(['pr', 'api']);
});

it('fails when gh api cannot read the head commit', async () => {
  const { run, fake } = await setUp(config);

  fake.failCommand('api');

  await expect(run()).rejects.toThrow('gh api');
});

it('fails when gh api prints no date for the head commit', async () => {
  const { run, fake } = await setUp(config);

  fake.overrideOutput('api', '\n');

  await expect(run()).rejects.toThrow('printed no committer date');
});

it('warns once for an unknown field inside a bot entry', async () => {
  const { run, notices } = await setUp({
    reviews: { repositories: { 'sQVe/tau': { bots: [{ ...bot, extra: 1 }] } } },
  });

  await run();
  await run();

  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('reviews.repositories.sQVe/tau.bots[0].extra');
});
