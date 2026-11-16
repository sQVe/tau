import { expect, it } from 'vitest';

import { parseRecordRequest } from './recordRequest.js';
import type { RecordInput, RecordRequest } from './recordRequest.js';

const table: {
  name: string;
  input: RecordInput;
  expected: RecordRequest | { error: string };
}[] = [
  {
    name: 'accepts a correction',
    input: { action: 'record', kind: 'correction', summary: 'Use run_tests.' },
    expected: { kind: 'correction', summary: 'Use run_tests.' },
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
    expected: { kind: 'backlog', review: 'review-1', item: 2, summary: 'Split the module.' },
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
    expected: { kind: 'decision', review: 'review-1', item: 2, choice: 'approved' },
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
    expected: { error: 'record kind correction needs summary.' },
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
