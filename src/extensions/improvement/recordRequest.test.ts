import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import { parameters, parseRecordRequest } from './recordRequest.js';
import type { RecordInput, RecordRequest } from './recordRequest.js';

const table: {
  name: string;
  input: RecordInput;
  expected: RecordRequest | { error: string };
}[] = [
  {
    name: 'accepts a correction',
    input: { action: 'record', kind: 'correction', summary: 'Use run_tests.' },
    expected: { action: 'record', kind: 'correction', summary: 'Use run_tests.' },
  },
  {
    name: 'accepts a review',
    input: {
      action: 'record',
      kind: 'review',
      pullRequest: 'https://github.com/example/repo/pull/1',
      outcome: 'The task passed.',
    },
    expected: {
      action: 'record',
      kind: 'review',
      pullRequest: 'https://github.com/example/repo/pull/1',
      outcome: 'The task passed.',
    },
  },
  {
    name: 'accepts a backlog item',
    input: {
      action: 'record',
      kind: 'backlog',
      review: 'review-1',
      item: 2,
      summary: 'Split the module.',
    },
    expected: {
      action: 'record',
      kind: 'backlog',
      review: 'review-1',
      item: 2,
      summary: 'Split the module.',
    },
  },
  {
    name: 'accepts a decision',
    input: {
      action: 'record',
      kind: 'decision',
      review: 'review-1',
      item: 2,
      choice: 'approved',
    },
    expected: {
      action: 'record',
      kind: 'decision',
      review: 'review-1',
      item: 2,
      choice: 'approved',
    },
  },
  {
    name: 'needs a correction summary',
    input: { action: 'record', kind: 'correction' },
    expected: { error: 'record kind correction needs summary.' },
  },
  {
    name: 'needs a review pull request',
    input: { action: 'record', kind: 'review', outcome: 'The task passed.' },
    expected: { error: 'record kind review needs pullRequest.' },
  },
  {
    name: 'needs a review outcome',
    input: {
      action: 'record',
      kind: 'review',
      pullRequest: 'https://github.com/example/repo/pull/1',
    },
    expected: { error: 'record kind review needs outcome.' },
  },
  {
    name: 'needs a backlog review',
    input: { action: 'record', kind: 'backlog', item: 2, summary: 'Split the module.' },
    expected: { error: 'record kind backlog needs review.' },
  },
  {
    name: 'needs a backlog item',
    input: { action: 'record', kind: 'backlog', review: 'review-1', summary: 'Split the module.' },
    expected: { error: 'record kind backlog needs item.' },
  },
  {
    name: 'needs a backlog summary',
    input: { action: 'record', kind: 'backlog', review: 'review-1', item: 2 },
    expected: { error: 'record kind backlog needs summary.' },
  },
  {
    name: 'needs a decision review',
    input: { action: 'record', kind: 'decision', item: 2, choice: 'approved' },
    expected: { error: 'record kind decision needs review.' },
  },
  {
    name: 'needs a decision item',
    input: { action: 'record', kind: 'decision', review: 'review-1', choice: 'approved' },
    expected: { error: 'record kind decision needs item.' },
  },
  {
    name: 'needs a decision choice',
    input: { action: 'record', kind: 'decision', review: 'review-1', item: 2 },
    expected: { error: 'record kind decision needs choice.' },
  },
  {
    name: 'needs a kind',
    input: { action: 'record', summary: 'Use run_tests.' },
    expected: { error: 'record needs kind.' },
  },
  {
    name: 'refuses a blank summary',
    input: { action: 'record', kind: 'correction', summary: ' \n\t ' },
    expected: { error: 'record kind correction needs a non-blank summary.' },
  },
  {
    name: 'refuses a blank pull request',
    input: {
      action: 'record',
      kind: 'review',
      pullRequest: ' ',
      outcome: 'The task passed.',
    },
    expected: { error: 'record kind review needs a non-blank pullRequest.' },
  },
  {
    name: 'refuses a blank outcome',
    input: {
      action: 'record',
      kind: 'review',
      pullRequest: 'https://github.com/example/repo/pull/1',
      outcome: '\n',
    },
    expected: { error: 'record kind review needs a non-blank outcome.' },
  },
  {
    name: 'refuses a blank review',
    input: { action: 'record', kind: 'backlog', review: '\t', item: 2, summary: 'Split it.' },
    expected: { error: 'record kind backlog needs a non-blank review.' },
  },
  {
    name: 'refuses a pull request that is not https',
    input: {
      action: 'record',
      kind: 'review',
      pullRequest: 'http://github.com/example/repo/pull/1',
      outcome: 'The task passed.',
    },
    expected: { error: 'record kind review pullRequest must start with https://.' },
  },
  {
    name: 'refuses a field the kind does not take',
    input: { action: 'record', kind: 'correction', summary: 'Use run_tests.', item: 2 },
    expected: { error: 'record kind correction does not take item.' },
  },
  {
    name: 'accepts a task',
    input: {
      action: 'task',
      pullRequest: 'https://github.com/example/repo/pull/1',
      worktree: '/repository/me-1',
    },
    expected: {
      action: 'task',
      pullRequest: 'https://github.com/example/repo/pull/1',
      worktree: '/repository/me-1',
    },
  },
  {
    name: 'needs a record kind',
    input: { action: 'record', summary: 'Use run_tests.' },
    expected: { error: 'record needs kind.' },
  },
  {
    name: 'needs a task pull request',
    input: { action: 'task', worktree: '/repository/me-1' },
    expected: { error: 'task needs pullRequest.' },
  },
  {
    name: 'needs a task worktree',
    input: { action: 'task', pullRequest: 'https://github.com/example/repo/pull/1' },
    expected: { error: 'task needs worktree.' },
  },
  {
    name: 'refuses a relative task worktree',
    input: {
      action: 'task',
      pullRequest: 'https://github.com/example/repo/pull/1',
      worktree: 'me-1',
    },
    expected: { error: 'task worktree must be absolute.' },
  },
  {
    name: 'refuses a blank task pull request',
    input: { action: 'task', pullRequest: ' ', worktree: '/repository/me-1' },
    expected: { error: 'task needs a non-blank pullRequest.' },
  },
  {
    name: 'refuses a blank task worktree',
    input: {
      action: 'task',
      pullRequest: 'https://github.com/example/repo/pull/1',
      worktree: ' ',
    },
    expected: { error: 'task needs a non-blank worktree.' },
  },
  {
    name: 'refuses a field the task does not take',
    input: {
      action: 'task',
      kind: 'review',
      pullRequest: 'https://github.com/example/repo/pull/1',
      worktree: '/repository/me-1',
    },
    expected: { error: 'task does not take kind.' },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, { input, expected }) => {
  const result = (() => {
    try {
      return parseRecordRequest(input);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  })();

  expect(result).toEqual(expected);
});

it('accepts a valid decision input', () => {
  expect(
    Value.Check(parameters, {
      action: 'record',
      kind: 'decision',
      review: 'review-1',
      item: 2,
      choice: 'approved',
    }),
  ).toBe(true);
});

it.each(
  [
    {
      name: 'an item below 1',
      input: {
        action: 'record',
        kind: 'decision',
        review: 'review-1',
        item: 0,
        choice: 'approved',
      },
    },
    {
      name: 'a fractional item',
      input: {
        action: 'record',
        kind: 'decision',
        review: 'review-1',
        item: 1.5,
        choice: 'approved',
      },
    },
    {
      name: 'an unknown choice',
      input: {
        action: 'record',
        kind: 'decision',
        review: 'review-1',
        item: 2,
        choice: 'maybe',
      },
    },
  ].map((row) => [row.name, row] as const),
)('refuses %s', (_name, { input }) => {
  expect(Value.Check(parameters, input)).toBe(false);
});
