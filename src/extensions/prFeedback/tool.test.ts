import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ExecCall } from '../../../tests/execFake.js';
import { fakePullRequest } from './fixtures/ghFake.js';
import type { GhFake } from './fixtures/ghFake.js';
import { feedbackDirectories, holdFeedback, person, setUp, thread } from './fixtures/toolSetup.js';

const commandName = (call: ExecCall) => call.commandArguments.slice(0, 2).join(' ');

describe('read', () => {
  it('returns the unresolved threads, reviews with a body, and conversation comments', async () => {
    const { root, fake, read } = await setUp();

    holdFeedback(fake);

    const result = await read();

    expect(result.directory.startsWith(join(root, '.tau', 'pr-feedback', '7-'))).toBe(true);

    expect(result).toEqual({
      bodies: expect.any(String) as unknown,
      directory: result.directory,
      feedback: join(result.directory, 'feedback.json'),
      gaps: [],
      viewer: 'sqve',
      pr: {
        number: 7,
        url: 'https://github.com/sQVe/tau/pull/7',
        author: 'sqve',
        headRefOid: 'abc123',
        state: 'OPEN',
        baseRefName: 'main',
        headRefName: 'feature',
        headRepository: 'tau',
        headRepositoryOwner: 'sQVe',
        isCrossRepository: false,
        maintainerCanModify: false,
        mergeable: 'MERGEABLE',
      },
      threads: [
        {
          id: 'thread-open',
          path: 'src/tau.ts',
          line: null,
          isOutdated: true,
          viewerCanReply: true,
          viewerCanResolve: false,
          replyTo: 101,
          fromPerson: true,
          startedByViewer: false,
          comments: [
            {
              id: 101,
              author: 'reviewer',
              isBot: false,
              body: 'Rename this.',
              url: 'https://github.com/sQVe/tau/pull/7#discussion_r101',
              createdAt: '2026-10-01T10:00:00Z',
              updatedAt: '2026-10-01T10:00:00Z',
            },
            {
              id: 102,
              author: 'sqve',
              isBot: false,
              body: 'Will do.',
              url: 'https://github.com/sQVe/tau/pull/7#discussion_r102',
              createdAt: '2026-10-01T10:00:00Z',
              updatedAt: '2026-10-01T10:00:00Z',
            },
            {
              id: 103,
              author: 'coderabbitai',
              isBot: true,
              body: 'Agreed.',
              url: 'https://github.com/sQVe/tau/pull/7#discussion_r103',
              createdAt: '2026-10-01T10:00:00Z',
              updatedAt: '2026-10-01T10:00:00Z',
            },
          ],
        },
      ],
      reviews: [
        {
          id: 201,
          author: 'coderabbitai',
          isBot: true,
          state: 'COMMENTED',
          body: 'Summary of the changes.',
          url: 'https://github.com/sQVe/tau/pull/7#pullrequestreview-201',
        },
      ],
      comments: [
        {
          id: 301,
          author: 'reviewer',
          isBot: false,
          body: 'Can this land today?',
          url: 'https://github.com/sQVe/tau/pull/7#issuecomment-301',
        },
      ],
      stateToken: result.stateToken,
    });

    expect(result.stateToken).toMatch(/^[0-9a-f]{64}$/u);

    expect(await feedbackDirectories(root)).toHaveLength(1);
  });

  it.each([
    { name: 'plain text', body: 'a'.repeat(65_536) },
    { name: 'escaped text', body: '\u0000'.repeat(65_536) },
    {
      name: 'a split surrogate pair',
      body: `${'a'.repeat(3999)}\uD83D\uDE00${'b'.repeat(61_535)}`,
    },
  ])('saves readable chunks of $name without losing body text', async ({ body }) => {
    const { fake, read } = await setUp();

    fake.threads = [thread({ id: 'long', comments: [{ id: 101, author: person, body }] })];
    fake.reviews = [{ id: 201, author: person, state: 'COMMENTED', body }];
    fake.comments = [{ id: 301, author: person, body }];

    const result = await read();
    const text = await readFile(String(result.feedback), 'utf8');

    const saved = JSON.parse(text) as {
      comments: { body: string[] }[];
      reviews: { body: string[] }[];
      threads: { comments: { body: string[] }[] }[];
    };

    const bodies = [
      ...saved.comments.map((comment) => comment.body),
      ...saved.reviews.map((review) => review.body),
      ...saved.threads.flatMap((item) => item.comments.map((comment) => comment.body)),
    ];

    expect(Math.max(...text.split('\n').map((line) => Buffer.byteLength(line)))).toBeLessThan(
      50 * 1024,
    );

    expect(bodies.every((chunks) => Array.isArray(chunks))).toBe(true);
    expect(bodies.map((chunks) => chunks.join(''))).toEqual([body, body, body]);
    expect(bodies.flat().every((chunk) => chunk.length <= 4000)).toBe(true);

    expect(result.threads).toEqual([
      expect.objectContaining({
        comments: [expect.objectContaining({ body: body.slice(0, 4000) })],
      }),
    ]);
  });

  it('saves full feedback and returns bounded bodies and lists with gaps', async () => {
    const { fake, read } = await setUp();
    const body = 'a'.repeat(12_000);

    fake.threads = [thread({ id: 'thread-long', comments: [{ id: 101, author: person, body }] })];
    fake.reviews = [{ id: 201, author: person, state: 'COMMENTED', body }];

    fake.comments = Array.from({ length: 30 }, (_, index) => ({
      id: 301 + index,
      author: person,
      body,
    }));

    const result = await read();

    const saved = JSON.parse(await readFile(String(result.feedback), 'utf8')) as {
      stateToken: string;
      comments: { body: string[] }[];
      threads: { comments: { body: string[] }[] }[];
      reviews: { body: string[] }[];
    };

    expect(result.feedback).toBe(join(result.directory, 'feedback.json'));
    expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(40_000);
    expect(saved.stateToken).toBe(result.stateToken);
    expect(saved.comments).toHaveLength(30);
    expect(saved.comments[29]?.body.join('')).toBe(body);
    expect(saved.threads[0]?.comments[0]?.body.join('')).toBe(body);
    expect(saved.reviews[0]?.body.join('')).toBe(body);

    expect(result.gaps).toEqual(
      expect.arrayContaining([
        { kind: 'truncatedBody', list: 'threads', id: 101, kept: 4000, total: 12_000 },
        { kind: 'truncatedBody', list: 'reviews', id: 201, kept: 4000, total: 12_000 },
        expect.objectContaining({ kind: 'truncatedList', list: 'comments', total: 30 }),
      ]),
    );

    fake.comments[29] = { id: 330, author: person, body: `${body}changed outside the excerpt` };

    const next = await read();

    expect(next.stateToken).not.toBe(result.stateToken);
  });

  it('returns a new stateToken only after a person comments', async () => {
    const { fake, read } = await setUp();

    holdFeedback(fake);

    const first = await read();
    const second = await read();

    fake.comments.push({ id: 302, author: person, body: 'One more thing.' });

    const third = await read();

    expect(second.stateToken).toBe(first.stateToken);
    expect(second.directory).not.toBe(first.directory);
    expect(third.stateToken).not.toBe(first.stateToken);
  });

  it('reads the pull request again while mergeable is UNKNOWN', async () => {
    const { fake, read } = await setUp();

    fake.nextMergeable = ['UNKNOWN', 'MERGEABLE'];

    const result = await read();
    const views = fake.calls.filter((call) => commandName(call) === 'pr view');

    expect(result.pr).toEqual(expect.objectContaining({ mergeable: 'MERGEABLE' }));
    expect(views).toHaveLength(2);
  });

  it('refuses when the head moves while it rereads mergeable', async () => {
    const { root, fake, read } = await setUp();

    fake.nextHeads = ['abc123', 'def456'];
    fake.nextMergeable = ['UNKNOWN', 'MERGEABLE'];

    await expect(read()).rejects.toThrow(
      'The pull request headRefOid changed from abc123 to def456 during the read. Read again.',
    );

    expect(await feedbackDirectories(root)).toEqual([]);
  });

  it('refuses when the base branch changes while it rereads mergeable', async () => {
    const { root, fake, read } = await setUp();

    fake.nextBases = ['main', 'release'];
    fake.nextMergeable = ['UNKNOWN', 'MERGEABLE'];

    await expect(read()).rejects.toThrow(
      'The pull request baseRefName changed from main to release during the read. Read again.',
    );

    expect(await feedbackDirectories(root)).toEqual([]);
  });

  it('refuses when the pull request closes while it rereads mergeable', async () => {
    const { root, fake, read } = await setUp();

    fake.nextStates = ['OPEN', 'CLOSED'];
    fake.nextMergeable = ['UNKNOWN', 'MERGEABLE'];

    await expect(read()).rejects.toThrow(
      'Pull request https://github.com/sQVe/tau/pull/7 is CLOSED, not OPEN.',
    );

    expect(await feedbackDirectories(root)).toEqual([]);
  });

  it('returns mergeable UNKNOWN after four reads that stay UNKNOWN', async () => {
    const { fake, read } = await setUp();

    fake.nextMergeable = ['UNKNOWN'];

    const result = await read();
    const views = fake.calls.filter((call) => commandName(call) === 'pr view');

    expect(result.pr).toEqual(expect.objectContaining({ mergeable: 'UNKNOWN' }));
    expect(views).toHaveLength(4);
  });

  it.each([
    { name: 'a fork', headRepository: 'tau-fork' },
    { name: 'a deleted fork', headRepository: null },
  ])('returns the branches and head repository of $name', async ({ headRepository }) => {
    const { fake, read } = await setUp();

    fake.pullRequest = {
      ...fakePullRequest(),
      baseRefName: 'release',
      headRefName: 'fix-typo',
      headRepository,
      headRepositoryOwner: 'contributor',
      isCrossRepository: true,
      maintainerCanModify: true,
    };

    const result = await read();

    expect(result.pr).toEqual(
      expect.objectContaining({
        state: 'OPEN',
        baseRefName: 'release',
        headRefName: 'fix-typo',
        headRepository,
        headRepositoryOwner: 'contributor',
        isCrossRepository: true,
        maintainerCanModify: true,
      }),
    );
  });
});

describe('read errors', () => {
  it('fails before other gh calls when gh auth status fails', async () => {
    const { root, fake, read } = await setUp();

    fake.failCommand('auth status', 'You are not logged into any GitHub hosts.');

    await expect(read()).rejects.toThrow(
      'gh auth status --active --hostname github.com failed: You are not logged into any GitHub hosts.',
    );

    expect(fake.calls.map((call) => commandName(call))).toEqual(['auth status']);
    expect(await feedbackDirectories(root)).toEqual([]);
  });

  it('passes --hostname to every gh api call', async () => {
    const { fake, read } = await setUp();

    await read({ repository: 'ghe.example.com/sQVe/tau' });

    const apiCalls = fake.calls.filter((call) => call.commandArguments[0] === 'api');

    expect(apiCalls).toHaveLength(4);

    for (const call of apiCalls) {
      expect(call.commandArguments).toEqual(
        expect.arrayContaining(['--hostname', 'ghe.example.com']),
      );
    }
  });

  it.each([
    {
      name: 'a missing pull request',
      arrange: (fake: GhFake) => {
        fake.pullRequest = undefined;
      },
      error:
        'gh pr view 7 --repo github.com/sQVe/tau --json number,url,state,author,headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify,mergeable,isDraft,mergeStateStatus,reviewDecision failed: no pull requests found',
    },
    {
      name: 'a failing gh call',
      arrange: (fake: GhFake) => {
        fake.failCommand('graphql');
      },
      error:
        'gh api graphql --hostname github.com --paginate --slurp -f owner=sQVe -f name=tau -F number=7 -f failed: HTTP 502',
    },
    {
      name: 'output that is not JSON',
      arrange: (fake: GhFake) => {
        fake.overrideOutput('reviews', 'Bad credentials');
      },
      error: 'repos/sQVe/tau/pulls/7/reviews printed output that is not JSON: Bad credentials',
    },
    {
      name: 'output that misses a field',
      arrange: (fake: GhFake) => {
        fake.overrideOutput('comments', JSON.stringify([[{ id: 301, user: null, body: 'Hi.' }]]));
      },
      error:
        'repos/sQVe/tau/issues/7/comments printed unexpected output: /0/0 must have required properties html_url',
    },
    {
      name: 'a thread comment without updatedAt',
      arrange: (fake: GhFake) => {
        const page = {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      ...thread({ id: 'thread-open' }),
                      comments: {
                        pageInfo: { hasNextPage: false },
                        nodes: [
                          { databaseId: 101, author: null, body: 'Hi.', url: 'u', createdAt: 'c' },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        };

        fake.overrideOutput('graphql', JSON.stringify([page]));
      },
      error: 'must have required properties updatedAt',
    },
    {
      name: 'a pull request that is not open',
      arrange: (fake: GhFake) => {
        fake.pullRequest = { ...fakePullRequest(), state: 'MERGED' };
      },
      error: 'Pull request https://github.com/sQVe/tau/pull/7 is MERGED, not OPEN.',
    },
    {
      name: 'a thread too long to read',
      arrange: (fake: GhFake) => {
        fake.threads = [thread({ id: 'thread-long', isResolved: true, hasMoreComments: true })];
      },
      error:
        'The review thread https://github.com/sQVe/tau/pull/7#discussion_r101 is too long to read in full.',
    },
  ])('fails on $name and creates no directory', async ({ arrange, error }) => {
    const { root, fake, read } = await setUp();

    holdFeedback(fake);
    arrange(fake);

    await expect(read()).rejects.toThrow(error);
    expect(await feedbackDirectories(root)).toEqual([]);
  });
});
