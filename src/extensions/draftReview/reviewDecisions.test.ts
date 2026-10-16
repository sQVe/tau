import { expect, it } from 'vitest';

import { decideEdit, reviewPlacement, selectReviewedComments } from './reviewDecisions.js';
import type { FileFacts, SessionComment } from './reviewDecisions.js';

const comment = (id: string, path: string | null): SessionComment => ({
  id,
  path,
  startLine: path === null ? null : 1,
  endLine: path === null ? null : 1,
  type: 'issue',
  content: id,
});

it('keeps only comments on reviewed files', () => {
  const comments = [
    comment('reviewed', 'slices/a.md'),
    comment('other', 'slices/other.md'),
    comment('session', null),
  ];

  const kept = selectReviewedComments(comments, ['slices/a.md', 'tickets/b.md']);

  expect(kept.map(({ id }) => id)).toEqual(['reviewed']);
});

it.each<{ name: string; facts: Partial<FileFacts>; decision: string }>([
  { name: 'the user changed nothing', facts: { staged: 'one' }, decision: 'unchanged' },
  { name: 'the user removed the staged file', facts: { staged: undefined }, decision: 'unchanged' },
  { name: 'the real file still matches', facts: { staged: 'two' }, decision: 'apply' },
  {
    name: 'the real file already holds the staged text',
    facts: { staged: 'two', current: 'two' },
    decision: 'apply',
  },
  {
    name: 'the real file changed during the review',
    facts: { staged: 'two', current: 'three' },
    decision: 'conflict',
  },
  {
    name: 'the real file is gone',
    facts: { staged: 'two', current: undefined },
    decision: 'conflict',
  },
])('decides $decision when $name', ({ facts, decision }) => {
  const base: FileFacts = { path: 'a.md', original: 'one', staged: 'one', current: 'one' };

  expect(decideEdit({ ...base, ...facts })).toBe(decision);
});

it('places the review right of a wide pane', () => {
  expect(reviewPlacement({ width: 164, zoomed: false, minimumWidth: 82 })).toBe('right');
});

it('places the review in a tab when the pane is one column too narrow', () => {
  expect(reviewPlacement({ width: 163, zoomed: false, minimumWidth: 82 })).toBe('tab');
});

it('places the review in a tab when the pane is zoomed', () => {
  expect(reviewPlacement({ width: 200, zoomed: true, minimumWidth: 82 })).toBe('tab');
});
