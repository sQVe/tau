import { expect, it } from 'vitest';

import {
  decideDestination,
  decideEdit,
  reviewPlacement,
  selectReviewedComments,
  stagedNames,
} from './reviewDecisions.js';
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

const tenFiles = Array.from({ length: 10 }, (_, index) => `pr/run-a/${String(index)}.md`);

it.each<{ name: string; paths: string[]; staged: string[] }>([
  {
    name: 'two runs listed in the opposite order of their names',
    paths: ['pr/run-b/title.md', 'pr/run-b/body.md', 'pr/run-a/title.md', 'pr/run-a/body.md'],
    staged: [
      '01-pr-run-b/1-title.md',
      '01-pr-run-b/2-body.md',
      '02-pr-run-a/1-title.md',
      '02-pr-run-a/2-body.md',
    ],
  },
  {
    name: 'a folder that comes back after another',
    paths: ['pr/run-b/title.md', 'slices/x.md', 'pr/run-b/body.md'],
    staged: ['01-pr-run-b/1-title.md', '02-slices/1-x.md', '01-pr-run-b/2-body.md'],
  },
  {
    name: 'a file directly in .tau',
    paths: ['slices/x.md', 'notes.md'],
    staged: ['01-slices/1-x.md', '02-notes.md'],
  },
  {
    name: 'two folders that flatten to one name',
    paths: ['pr/run-a/x.md', 'pr-run/a/x.md'],
    staged: ['01-pr-run-a/1-x.md', '02-pr-run-a/1-x.md'],
  },
  {
    name: 'ten files in one folder',
    paths: tenFiles,
    staged: tenFiles.map(
      (_, index) => `01-pr-run-a/${String(index + 1).padStart(2, '0')}-${String(index)}.md`,
    ),
  },
])('stages $name under numbered names', ({ paths, staged }) => {
  expect(stagedNames(paths)).toEqual(staged);
});

it.each([
  { name: 'a 255-byte file directly in .tau', paths: [`${'a'.repeat(252)}.md`] },
  {
    name: 'two folders that flatten past 255 bytes',
    paths: [`${'b'.repeat(130)}/${'c'.repeat(130)}/x.md`],
  },
  { name: 'a 255-byte file name of multibyte characters', paths: [`d/${'é'.repeat(127)}a`] },
])('keeps each staged name part within 255 bytes for $name', ({ paths }) => {
  const parts = stagedNames(paths).flatMap((staged) => staged.split('/'));

  expect(parts.every((part) => Buffer.byteLength(part) <= 255)).toBe(true);
  expect(parts.every((part) => /^\d+-/.test(part))).toBe(true);
});

it('stages names that sort in the order of the paths', () => {
  const paths = Array.from({ length: 12 }, (_, index) => `run-${String(11 - index)}/body.md`);
  const staged = stagedNames(paths);

  expect(staged.toSorted()).toEqual(staged);
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

it.each<{ name: string; width: number; zoomed: boolean; placement: string }>([
  { name: 'the pane has room for two halves', width: 164, zoomed: false, placement: 'right' },
  { name: 'the pane is one column too narrow', width: 163, zoomed: false, placement: 'tab' },
  { name: 'the pane is zoomed', width: 200, zoomed: true, placement: 'tab' },
])('places the review $placement when $name', ({ width, zoomed, placement }) => {
  expect(reviewPlacement({ width, zoomed, minimumWidth: 82 })).toBe(placement);
});

it.each([
  { kind: 'file', linkCount: 1, inside: true, expected: 'writable' },
  { kind: 'symlink', linkCount: 1, inside: true, expected: 'symlink' },
  { kind: 'other', linkCount: 1, inside: true, expected: 'not-file' },
  { kind: 'file', linkCount: 2, inside: true, expected: 'hard-linked' },
  { kind: 'file', linkCount: 1, inside: false, expected: 'outside' },
  { kind: 'symlink', linkCount: 2, inside: false, expected: 'symlink' },
] as const)(
  'decides $expected for a $kind with $linkCount links, inside .tau: $inside',
  ({ kind, linkCount, inside, expected }) => {
    expect(decideDestination({ kind, linkCount, insideTauDirectory: inside })).toBe(expected);
  },
);
