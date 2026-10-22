import { expect, it } from 'vitest';

import { findRepositoryEntry } from './repositoryEntry.js';

const source = '/home/u/tau.json';

it.each([
  { keys: { 'sQVe/cape': 1 }, repository: 'sQVe/cape', found: ['sQVe/cape', 1] },
  { keys: { 'sqve/CAPE': 2 }, repository: 'sQVe/cape', found: ['sqve/CAPE', 2] },
  { keys: { 'sQVe/tau': 3 }, repository: 'sQVe/cape', found: undefined },
  { keys: {}, repository: 'sQVe/cape', found: undefined },
])('finds $found for $repository in $keys', ({ keys, repository, found }) => {
  expect(findRepositoryEntry(source, 'qa.repositories', keys, repository)).toEqual(found);
});

it('refuses keys that differ only in case and names the field', () => {
  const keys = { 'sQVe/cape': 1, 'sqve/cape': 2 };

  expect(() => findRepositoryEntry(source, 'qa.repositories', keys, 'SQVE/CAPE')).toThrow(
    'qa.repositories has both "sQVe/cape" and "sqve/cape"',
  );
});

it('ignores case-only duplicates of another repository', () => {
  const keys = { 'a/b': 1, 'A/B': 2, 'sQVe/cape': 3 };

  expect(findRepositoryEntry(source, 'qa.repositories', keys, 'sQVe/cape')).toEqual([
    'sQVe/cape',
    3,
  ]);
});
