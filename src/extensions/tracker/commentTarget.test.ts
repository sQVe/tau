import { expect, it } from 'vitest';

import { decideCommentTarget } from './commentTarget.js';
import type { TicketComment } from './commentTarget.js';

const heading = '# Code quality: ME-1';
const quality = { id: 'q1', url: 'quality', body: `${heading}\nold`, user: { id: 'viewer' } };
const duplicate = { ...quality, id: 'q2' };
const review = { ...quality, id: 'r1', body: '# Code review: ME-1\nold' };
const foreign = { ...quality, id: 'other', user: { id: 'other' } };

const cases: { label: string; comments: TicketComment[]; savedId?: string; expected: unknown }[] = [
  { label: 'no comments', comments: [], expected: { kind: 'add' } },
  {
    label: 'single heading match',
    comments: [quality],
    expected: { kind: 'update', comment: quality },
  },
  {
    label: 'saved ID before duplicate headings',
    comments: [quality, duplicate],
    savedId: 'q2',
    expected: { kind: 'update', comment: duplicate },
  },
  {
    label: 'saved ID after heading changes',
    comments: [review],
    savedId: 'r1',
    expected: { kind: 'update', comment: review },
  },
  {
    label: 'missing saved ID falls back to heading',
    comments: [quality],
    savedId: 'missing',
    expected: { kind: 'update', comment: quality },
  },
  {
    label: 'foreign saved ID does not match',
    comments: [foreign, quality],
    savedId: 'other',
    expected: { kind: 'update', comment: quality },
  },
  { label: 'foreign headings do not match', comments: [foreign], expected: { kind: 'add' } },
  {
    label: 'unknown author does not match',
    comments: [{ ...quality, user: null }],
    expected: { kind: 'add' },
  },
  { label: 'review does not match quality', comments: [review], expected: { kind: 'add' } },
  {
    label: 'heading must be the exact first line',
    comments: [{ ...quality, body: `prefix\n${heading}` }],
    expected: { kind: 'add' },
  },
  {
    label: 'heading whitespace is significant',
    comments: [{ ...quality, body: `${heading} \nold` }],
    expected: { kind: 'add' },
  },
  {
    label: 'duplicate headings refuse with IDs',
    comments: [quality, duplicate],
    expected: { kind: 'refuse', ids: ['q1', 'q2'] },
  },
];

it.each(cases)('selects a comment target: $label', ({ comments, savedId, expected }) => {
  expect(decideCommentTarget({ viewer: 'viewer', heading, savedId, comments })).toEqual(expected);
});
