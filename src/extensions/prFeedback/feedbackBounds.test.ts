import { expect, it } from 'vitest';

import { boundFeedback, chunkFeedbackBodies } from './feedbackBounds.js';
import type { PullRequestFeedback } from './read.js';
import type { Comment, Review, Thread } from './threads.js';

const comment = (id: number, body: string): Comment => ({
  id,
  author: 'reviewer',
  isBot: false,
  body,
  url: `https://github.com/o/r/pull/1#${id}`,
});

const review = (id: number, body: string): Review => ({
  ...comment(id, body),
  state: 'COMMENTED',
});

const thread = (id: string, bodies: string[]): Thread => ({
  id,
  path: 'src/main.ts',
  line: 1,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  replyTo: 1,
  fromPerson: true,
  startedByViewer: false,
  comments: bodies.map((body, index) => ({
    ...comment(index + 1, body),
    createdAt: 'today',
    updatedAt: 'today',
  })),
});

const feedback = (overrides: Partial<PullRequestFeedback> = {}): PullRequestFeedback => ({
  viewer: 'author',
  pr: { number: 1, url: 'https://github.com/o/r/pull/1', author: 'author', headRefOid: 'head' },
  threads: [],
  reviews: [],
  comments: [],
  stateToken: 'full-feedback-token',
  ...overrides,
});

const paths = { directory: '/round', feedback: '/round/feedback.json' };

it.each([
  { name: 'an empty body', body: '', count: 0 },
  { name: 'a short body', body: 'body', count: 1 },
  { name: 'a body at the chunk limit', body: 'a'.repeat(4000), count: 1 },
  { name: 'a body past the chunk limit', body: 'a'.repeat(4001), count: 2 },
])('chunks $name for storage without changing the source', ({ body, count }) => {
  const full = feedback({
    threads: [thread('one', [body])],
    reviews: [review(201, body)],
    comments: [comment(301, body)],
  });

  const original = structuredClone(full);
  const saved = chunkFeedbackBodies(full);

  const bodies = [
    ...saved.comments.map((item) => item.body),
    ...saved.reviews.map((item) => item.body),
    ...saved.threads.flatMap((item) => item.comments.map((entry) => entry.body)),
  ];

  expect(bodies.map((chunks) => chunks.length)).toEqual([count, count, count]);
  expect(bodies.map((chunks) => chunks.join(''))).toEqual([body, body, body]);
  expect(bodies.flat().every((chunk) => chunk.length <= 4000)).toBe(true);
  expect(saved.stateToken).toBe(full.stateToken);
  expect(full).toEqual(original);
});

it.each([
  { name: 'empty feedback', full: feedback(), gaps: [] },
  {
    name: 'a body at the limit',
    full: feedback({ comments: [comment(1, 'a'.repeat(4000))] }),
    gaps: [],
  },
  {
    name: 'a conversation body past the limit',
    full: feedback({ comments: [comment(1, 'a'.repeat(4001))] }),
    gaps: [{ kind: 'truncatedBody', list: 'comments', id: 1, kept: 4000, total: 4001 }],
  },
  {
    name: 'a review body past the limit',
    full: feedback({ reviews: [review(2, 'a'.repeat(4001))] }),
    gaps: [{ kind: 'truncatedBody', list: 'reviews', id: 2, kept: 4000, total: 4001 }],
  },
  {
    name: 'a thread body past the limit',
    full: feedback({ threads: [thread('one', ['a'.repeat(4001)])] }),
    gaps: [{ kind: 'truncatedBody', list: 'threads', id: 1, kept: 4000, total: 4001 }],
  },
])('bounds $name without changing the source', ({ full, gaps }) => {
  const original = structuredClone(full);
  const result = boundFeedback(full, paths);

  expect(result.gaps).toEqual(gaps);

  expect(result.comments.map((item) => item.body)).toEqual(
    full.comments.map((item) => item.body.slice(0, 4000)),
  );

  expect(result.reviews.map((item) => item.body)).toEqual(
    full.reviews.map((item) => item.body.slice(0, 4000)),
  );

  expect(result.threads.flatMap((item) => item.comments.map((entry) => entry.body))).toEqual(
    full.threads.flatMap((item) => item.comments.map((entry) => entry.body.slice(0, 4000))),
  );

  expect(result.stateToken).toBe(full.stateToken);
  expect(result.feedback).toBe(paths.feedback);
  expect(full).toEqual(original);
});

it.each([
  {
    name: 'many threads with cut bodies',
    full: feedback({
      threads: Array.from({ length: 100 }, (_, index) => thread(String(index), ['x'.repeat(5000)])),
    }),
    list: 'threads',
  },
  {
    name: 'many reviews with escaped characters',
    full: feedback({
      reviews: Array.from({ length: 100 }, (_, index) => review(index, '\u0000'.repeat(5000))),
    }),
    list: 'reviews',
  },
  {
    name: 'many conversation comments',
    full: feedback({
      comments: Array.from({ length: 1000 }, (_, index) => comment(index, 'body')),
    }),
    list: 'comments',
  },
] as const)('keeps a prefix and bounded gaps for $name', ({ full, list }) => {
  const result = boundFeedback(full, paths);
  const kept = result[list].length;

  expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(40_000);
  expect(kept).toBeGreaterThan(0);
  expect(kept).toBeLessThan(full[list].length);

  expect(result[list].map((item) => item.id)).toEqual(
    full[list].slice(0, kept).map((item) => item.id),
  );

  expect(result.gaps).toContainEqual({
    kind: 'truncatedList',
    list,
    kept,
    total: full[list].length,
  });

  expect(result.gaps.filter((gap) => gap.kind === 'truncatedBody').length).toBeLessThanOrEqual(
    kept,
  );
});

it('stops at an oversized thread and spends the remaining budget on later lists', () => {
  const full = feedback({
    threads: [
      thread(
        'oversized',
        Array.from({ length: 100 }, () => 'x'.repeat(5000)),
      ),
      thread('small', ['body']),
    ],
    reviews: [review(201, 'review')],
    comments: [comment(301, 'comment')],
  });

  const result = boundFeedback(full, paths);

  expect(result.threads).toEqual([]);
  expect(result.reviews).toEqual(full.reviews);
  expect(result.comments).toEqual(full.comments);
  expect(result.gaps).toEqual([{ kind: 'truncatedList', list: 'threads', kept: 0, total: 2 }]);
  expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(40_000);
});

it('refuses oversized metadata with the saved feedback path and leaves the source unchanged', () => {
  const full = feedback({ viewer: 'x'.repeat(40_000) });
  const original = structuredClone(full);

  expect(() => boundFeedback(full, paths)).toThrow(paths.feedback);
  expect(full).toEqual(original);
});

it('counts all lists and their gaps against one result budget', () => {
  const full = feedback({
    threads: [thread('one', ['x'.repeat(5000)])],
    reviews: [review(201, 'x'.repeat(5000))],
    comments: Array.from({ length: 100 }, (_, index) => comment(index + 301, 'x'.repeat(5000))),
  });

  const result = boundFeedback(full, paths);

  expect(result.threads).toHaveLength(1);
  expect(result.reviews).toHaveLength(1);
  expect(result.comments.length).toBeGreaterThan(0);
  expect(result.comments.length).toBeLessThan(100);
  expect(JSON.stringify(result, null, 2).length).toBeLessThanOrEqual(40_000);

  expect(result.gaps).toContainEqual({
    kind: 'truncatedList',
    list: 'comments',
    kept: result.comments.length,
    total: 100,
  });
});
