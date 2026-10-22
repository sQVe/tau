import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { createGhFake } from './fixtures/ghFake.js';
import type { FakePullRequest } from './fixtures/ghFake.js';
import { readReviewBots } from './reviewBotSettings.js';
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
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-review-bots-');
  const fake = createGhFake();
  const notices: string[] = [];

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
  { condition: 'reviews has no repositories', user: { reviews: {} } },
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
    condition: 'a bot is not an object',
    reviews: { repositories: { 'sQVe/tau': { bots: ['codex'] } } },
    error: 'bots[0] must be an object',
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

it('reads pull request 1', async () => {
  const { run, fake } = await setUp(config);

  fake.pullRequests[repository] = [pullRequest({ number: 1 })];

  await expect(run({ pr: 1 })).resolves.toEqual({ bots: [{ ...bot, status: 'request' }] });
});

it('asks for a bot when the only review has a deleted author and no commit', async () => {
  const { run, fake } = await setUp(config);

  fake.overrideOutput(
    'pr view',
    JSON.stringify({
      headRefOid: 'abc123',
      reviews: [{ author: null, commit: null }],
      comments: [],
    }),
  );

  await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'request' }] });
});

it.each([
  { condition: 'a review is null', reviews: [null] },
  { condition: 'an author is text', reviews: [{ author: 'codex', commit: null }] },
  { condition: 'an author has no login', reviews: [{ author: {}, commit: null }] },
  { condition: 'a commit is text', reviews: [{ author: null, commit: 'abc123' }] },
  { condition: 'a commit has no oid', reviews: [{ author: null, commit: {} }] },
  { condition: 'a review has no commit', reviews: [{ author: null }] },
])('fails when the gh output has a review where $condition', async ({ reviews }) => {
  const { run, fake } = await setUp(config);

  fake.overrideOutput('pr view', JSON.stringify({ headRefOid: 'abc123', reviews, comments: [] }));

  await expect(run()).rejects.toThrow(/^gh pr view 7 /u);
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

  expect(fake.calls.map(({ commandArguments }) => commandArguments[0])).toEqual([
    'pr',
    'api',
    'api',
  ]);
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

describe('check suites', () => {
  const requestBetween = [{ body: bot.comment, createdAt: '2026-10-14T10:05:00Z' }];

  it('counts a request only from the earliest check suite of the head', async () => {
    const { run, fake } = await setUp(config);

    fake.pullRequests[repository] = [
      pullRequest({
        comments: requestBetween,
        headCheckSuites: ['2026-10-14T10:20:00Z', '2026-10-14T10:10:00Z'],
      }),
    ];

    await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'request' }] });

    expect(fake.calls.at(-1)?.commandArguments).toEqual([
      'api',
      '--hostname',
      'github.com',
      'repos/sQVe/tau/commits/abc123/check-suites',
      '--paginate',
      '--jq',
      '.check_suites[].created_at',
    ]);
  });

  it.each([
    {
      order: 'latest first',
      suites: ['2026-10-14T10:30:00Z', '2026-10-14T10:20:00Z', '2026-10-14T10:10:00Z'],
    },
    {
      order: 'earliest first',
      suites: ['2026-10-14T10:10:00Z', '2026-10-14T10:20:00Z', '2026-10-14T10:30:00Z'],
    },
    {
      order: 'earliest in the middle',
      suites: ['2026-10-14T10:20:00Z', '2026-10-14T10:10:00Z', '2026-10-14T10:30:00Z'],
    },
  ])(
    'counts a request after the earliest suite when the suites come $order',
    async ({ suites }) => {
      const { run, fake } = await setUp(config);

      fake.pullRequests[repository] = [
        pullRequest({
          comments: [{ body: bot.comment, createdAt: '2026-10-14T10:15:00Z' }],
          headCheckSuites: suites,
        }),
      ];

      await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'requested' }] });
    },
  );

  it('counts a request after the check suite', async () => {
    const { run, fake } = await setUp(config);

    fake.pullRequests[repository] = [
      pullRequest({ comments: requestBetween, headCheckSuites: ['2026-10-14T10:02:00Z'] }),
    ];

    await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'requested' }] });
  });

  it('falls back to the committer date when the head has no check suites', async () => {
    const { run, fake } = await setUp(config);

    fake.pullRequests[repository] = [pullRequest({ comments: requestBetween })];
    fake.overrideOutput('check-suites', '');

    await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'requested' }] });
  });

  it('reads the earliest time across pages', async () => {
    const { run, fake } = await setUp(config);

    fake.pullRequests[repository] = [pullRequest({ comments: requestBetween })];
    fake.overrideOutput('check-suites', '2026-10-14T10:30:00Z\n2026-10-14T10:10:00Z\n');

    await expect(run()).resolves.toEqual({ bots: [{ ...bot, status: 'request' }] });
  });

  it.each(['not a date\n', '2026-10-14T10:30:00Z\n{"oops":1}\n'])(
    'fails when gh api prints malformed check suites %j',
    async (output) => {
      const { run, fake } = await setUp(config);

      fake.overrideOutput('check-suites', output);

      await expect(run()).rejects.toThrow('printed a check suite time that is not a date');
    },
  );

  it('fails when gh api cannot read the check suites', async () => {
    const { run, fake } = await setUp(config);

    fake.failCommand('check-suites');

    await expect(run()).rejects.toThrow('gh api');
  });
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

it('refuses a matched entry key that is not owner/name', async () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-review-bots-');

  await writeFile(
    join(agentDirectory, 'tau.json'),
    JSON.stringify({ reviews: { repositories: { tau: { bots: [bot] } } } }),
  );

  const location = { cwd: agentDirectory, agentDirectory, projectTrusted: true };

  expect(() => readReviewBots(location, { notify: () => undefined }, 'tau')).toThrow(
    '"tau" in reviews.repositories must be an owner/name',
  );
});
