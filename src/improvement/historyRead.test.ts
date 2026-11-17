import { expect, it } from 'vitest';

import {
  capProjectRoots,
  capPullRequests,
  decideCoverage,
  parseInlineComments,
  parseReverts,
  parseReviewView,
  truncateBody,
} from './historyRead.js';
import type { HistoryGap } from './historyRead.js';

const pullRequest = 'https://github.com/sqve/tau/pull/562';

const gap = (source: string): HistoryGap => ({ source, reason: 'read failed' });

it.each([
  {
    name: 'is complete when every source is read',
    readSources: 2,
    gaps: [],
    expected: 'complete',
  },
  {
    name: 'is partial when one source failed',
    readSources: 1,
    gaps: [gap('/repository/tau')],
    expected: 'partial',
  },
  {
    name: 'is partial when a list was capped',
    readSources: 10,
    gaps: [gap('projectRoots')],
    expected: 'partial',
  },
  {
    name: 'is partial when a body was truncated',
    readSources: 1,
    gaps: [gap(pullRequest)],
    expected: 'partial',
  },
  {
    name: 'is unknown when no source could be read',
    readSources: 0,
    gaps: [gap('/repository/tau'), gap(pullRequest)],
    expected: 'unknown',
  },
] as const)('$name', ({ readSources, gaps, expected }) => {
  expect(decideCoverage(readSources, gaps)).toBe(expected);
});

it('reads the first ten project roots and reports the cap', () => {
  const roots = Array.from({ length: 11 }, (_, index) => `/repository/${index + 1}`);

  expect(capProjectRoots(roots)).toEqual({
    entries: roots.slice(0, 10),
    gap: { source: 'projectRoots', reason: 'capped at 10' },
  });
});

it('reads the first twenty pull requests and reports the cap', () => {
  const pullRequests = Array.from(
    { length: 21 },
    (_, index) => `https://github.com/sqve/tau/pull/${index + 1}`,
  );

  expect(capPullRequests(pullRequests)).toEqual({
    entries: pullRequests.slice(0, 20),
    gap: { source: 'pullRequests', reason: 'capped at 20' },
  });
});

it('adds no cap gap when a list fits', () => {
  expect(capProjectRoots(['/repository/tau'])).toEqual({
    entries: ['/repository/tau'],
    gap: undefined,
  });
});

it('parses each revert line into a commit and subject', () => {
  expect(
    parseReverts('/repository/tau', 'abc123\tRevert "Add a check"\ndef456\tRevert "Drop it"\n'),
  ).toEqual([
    { projectRoot: '/repository/tau', commit: 'abc123', subject: 'Revert "Add a check"' },
    { projectRoot: '/repository/tau', commit: 'def456', subject: 'Revert "Drop it"' },
  ]);
});

it('parses reviews and comments from a pull request view', () => {
  const output = JSON.stringify({
    reviews: [{ author: { login: 'reviewer' }, state: 'APPROVED', body: 'Looks good.' }],
    comments: [{ author: { login: 'author' }, body: 'Fixed.' }],
  });

  expect(parseReviewView(pullRequest, output)).toEqual({
    reviews: [{ url: pullRequest, author: 'reviewer', state: 'APPROVED', body: 'Looks good.' }],
    comments: [{ url: pullRequest, author: 'author', body: 'Fixed.' }],
    gaps: [],
  });
});

it('parses inline review comments', () => {
  const output = JSON.stringify([[{ user: { login: 'reviewer' }, body: 'Use the helper.' }]]);

  expect(parseInlineComments(pullRequest, output)).toEqual({
    comments: [{ url: pullRequest, author: 'reviewer', body: 'Use the helper.' }],
    gaps: [],
  });
});

it('flattens every inline comment page', () => {
  const output = JSON.stringify([
    [{ user: { login: 'first' }, body: 'First page.' }],
    [{ user: { login: 'second' }, body: 'Second page.' }],
  ]);

  expect(parseInlineComments(pullRequest, output)).toEqual({
    comments: [
      { url: pullRequest, author: 'first', body: 'First page.' },
      { url: pullRequest, author: 'second', body: 'Second page.' },
    ],
    gaps: [],
  });
});

it('truncates a long body and names its pull request in one gap', () => {
  const body = 'x'.repeat(2_001);

  expect(truncateBody(pullRequest, body)).toEqual({
    body: 'x'.repeat(2_000),
    gap: { source: pullRequest, reason: 'body truncated at 2000 characters' },
  });
});

it('keeps a body at the limit unchanged', () => {
  const body = 'x'.repeat(2_000);

  expect(truncateBody(pullRequest, body)).toEqual({ body, gap: undefined });
});
