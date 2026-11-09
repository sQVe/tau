import { expect, it } from 'vitest';

import { snapshotChange } from './snapshotChange.js';
import type { PullRequestSnapshot } from './snapshotChange.js';

const first: PullRequestSnapshot = {
  number: 7,
  url: 'https://github.com/sQVe/tau/pull/7',
  author: 'sqve',
  headRefOid: 'abc123',
  state: 'OPEN',
  baseRefName: 'main',
  headRefName: 'feature',
  headRepository: 'tau',
  headRepositoryOwner: 'sQVe',
  isCrossRepository: false,
  maintainerCanModify: false,
};

it.each([
  { name: 'nothing changed', current: first, change: undefined },
  {
    name: 'the head moved',
    current: { ...first, headRefOid: 'def456' },
    change: { field: 'headRefOid', before: 'abc123', after: 'def456' },
  },
  {
    name: 'the base branch changed',
    current: { ...first, baseRefName: 'release' },
    change: { field: 'baseRefName', before: 'main', after: 'release' },
  },
  {
    name: 'maintainerCanModify changed',
    current: { ...first, maintainerCanModify: true },
    change: { field: 'maintainerCanModify', before: false, after: true },
  },
  {
    name: 'the head repository was deleted',
    current: { ...first, headRepository: null },
    change: { field: 'headRepository', before: 'tau', after: null },
  },
  {
    name: 'only mergeable changed',
    current: { ...first, mergeable: 'MERGEABLE' },
    change: undefined,
  },
])('reports the first changed field when $name', ({ current, change }) => {
  // read keeps mergeable beside these fields, so a snapshot can carry it.
  const read = { ...first, mergeable: 'UNKNOWN' };

  expect(snapshotChange(read, current)).toEqual(change);
});
