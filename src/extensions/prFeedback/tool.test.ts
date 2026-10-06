import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { isMissingFile } from '../../errors.js';
import { createGhFake } from './fixtures/ghFake.js';
import type { FakeThread, GhFake } from './fixtures/ghFake.js';
import { createPrFeedbackTool } from './tool.js';
import type { PrFeedbackInput } from './tool.js';

const person = { login: 'reviewer', bot: false };
const bot = { login: 'coderabbitai', bot: true };

const thread = (overrides: Partial<FakeThread> & { id: string }): FakeThread => ({
  path: 'src/tau.ts',
  line: 12,
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  hasMoreComments: false,
  comments: [{ id: 101, author: person, body: 'Rename this.' }],
  ...overrides,
});

const setUp = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createGhFake();

  const read = async (input: Partial<PrFeedbackInput> = {}) => {
    const tool = createPrFeedbackTool(fake.exec);

    const result = await tool.execute(
      'call',
      { action: 'read', repository: 'github.com/sQVe/tau', pr: 7, ...input },
      undefined,
      undefined,
      noUiContext(root),
    );

    return result.details as Record<string, unknown> & { directory: string; stateToken: string };
  };

  return { root, fake, read };
};

const feedbackDirectories = (root: string) =>
  readdir(join(root, '.tau', 'pr-feedback')).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  });

const holdFeedback = (fake: GhFake) => {
  fake.threads = [
    thread({
      id: 'thread-resolved',
      isResolved: true,
      comments: [{ id: 90, author: person, body: 'Fixed already.' }],
    }),
    thread({
      id: 'thread-open',
      line: null,
      isOutdated: true,
      viewerCanResolve: false,
      comments: [
        { id: 101, author: person, body: 'Rename this.' },
        { id: 102, author: { login: 'sqve', bot: false }, body: 'Will do.' },
        { id: 103, author: bot, body: 'Agreed.' },
      ],
    }),
  ];

  fake.reviews = [
    { id: 201, author: bot, state: 'COMMENTED', body: 'Summary of the changes.' },
    { id: 202, author: person, state: 'APPROVED', body: '' },
  ];

  fake.comments = [{ id: 301, author: person, body: 'Can this land today?' }];
};

describe('read', () => {
  it('returns the unresolved threads, reviews with a body, and conversation comments', async () => {
    const { root, fake, read } = await setUp();

    holdFeedback(fake);

    const result = await read();

    expect(result.directory.startsWith(join(root, '.tau', 'pr-feedback', '7-'))).toBe(true);

    expect(result).toEqual({
      directory: result.directory,
      feedback: join(result.directory, 'feedback.json'),
      gaps: [],
      viewer: 'sqve',
      pr: {
        number: 7,
        url: 'https://github.com/sQVe/tau/pull/7',
        author: 'sqve',
        headRefOid: 'abc123',
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
});

describe('read errors', () => {
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
    { repository: 'sQVe/tau', pr: 7, error: 'repository must be <host>/<owner>/<name>' },
    { repository: 'github.com/sQVe/tau/pulls', pr: 7, error: 'repository must be' },
    { repository: 'github.com/sQVe/tau', pr: 0, error: 'pr must be a pull request number' },
    { repository: 'github.com/sQVe/tau', pr: 1.5, error: 'pr must be a pull request number' },
  ])('rejects repository $repository with pr $pr', async ({ repository, pr, error }) => {
    const { root, fake, read } = await setUp();

    await expect(read({ repository, pr })).rejects.toThrow(error);
    expect(fake.calls).toEqual([]);
    expect(await feedbackDirectories(root)).toEqual([]);
  });

  it.each([
    {
      name: 'a missing pull request',
      arrange: (fake: GhFake) => {
        fake.pullRequest = undefined;
      },
      error:
        'gh pr view 7 --repo github.com/sQVe/tau --json number,url,state,author,headRefOid failed: no pull requests found',
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
        fake.pullRequest = { number: 7, state: 'MERGED', author: 'sqve', headRefOid: 'abc123' };
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
