import { expect, it } from 'vitest';

import { decideReviewBots } from './reviewBotDecisions.js';
import type { ReviewBotFacts } from './reviewBotDecisions.js';

const bot = { login: 'codex[bot]', comment: '@codex review' };
const headCommittedAt = '2026-10-14T10:00:00Z';

const facts = (overrides: Partial<ReviewBotFacts> = {}): ReviewBotFacts => ({
  bots: [bot],
  head: 'new',
  headCommittedAt,
  reviews: [],
  comments: [],
  ...overrides,
});

const statusOf = (overrides: Partial<ReviewBotFacts>) =>
  decideReviewBots(facts(overrides)).map(({ status }) => status);

it.each([
  { name: 'nothing happened yet', overrides: {}, status: 'request' },
  {
    name: 'the bot reviewed the head',
    overrides: { reviews: [{ login: 'codex[bot]', commit: 'new' }] },
    status: 'reviewed',
  },
  {
    name: 'the login differs only in case',
    overrides: { reviews: [{ login: 'Codex[bot]', commit: 'new' }] },
    status: 'reviewed',
  },
  {
    name: 'the bot reviewed an older commit',
    overrides: { reviews: [{ login: 'codex[bot]', commit: 'old' }] },
    status: 'request',
  },
  {
    name: 'another login reviewed the head',
    overrides: { reviews: [{ login: 'other[bot]', commit: 'new' }] },
    status: 'request',
  },
  {
    name: 'a review has no commit',
    overrides: { reviews: [{ login: 'codex[bot]', commit: undefined }] },
    status: 'request',
  },
  {
    name: 'the request came after the head commit',
    overrides: { comments: [{ body: '@codex review', createdAt: '2026-10-14T10:05:00Z' }] },
    status: 'requested',
  },
  {
    name: 'the request came at the head commit time',
    overrides: { comments: [{ body: '@codex review', createdAt: headCommittedAt }] },
    status: 'requested',
  },
  {
    name: 'the request came before the head commit',
    overrides: { comments: [{ body: '@codex review', createdAt: '2026-10-14T09:00:00Z' }] },
    status: 'request',
  },
  {
    name: 'a comment has other text',
    overrides: { comments: [{ body: '@codex review please', createdAt: '2026-10-14T10:05:00Z' }] },
    status: 'request',
  },
  {
    name: 'the head was reviewed and requested',
    overrides: {
      reviews: [{ login: 'codex[bot]', commit: 'new' }],
      comments: [{ body: '@codex review', createdAt: '2026-10-14T10:05:00Z' }],
    },
    status: 'reviewed',
  },
])('returns $status when $name', ({ overrides, status }) => {
  expect(statusOf(overrides)).toEqual([status]);
});

it('decides each bot on its own and keeps the order', () => {
  const second = { login: 'other[bot]', comment: '/review' };

  const decisions = decideReviewBots(
    facts({ bots: [bot, second], reviews: [{ login: 'other[bot]', commit: 'new' }] }),
  );

  expect(decisions).toEqual([
    { ...bot, status: 'request' },
    { ...second, status: 'reviewed' },
  ]);
});

it('returns no decisions without bots', () => {
  expect(statusOf({ bots: [] })).toEqual([]);
});
