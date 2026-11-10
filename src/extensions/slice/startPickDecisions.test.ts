import { expect, it } from 'vitest';

import { decidePick } from './startPickDecisions.js';
import type { PickSlice } from './startPickDecisions.js';

const slice = (identifier: string, overrides: Partial<PickSlice> = {}): PickSlice => ({
  identifier,
  title: identifier,
  url: `https://linear.app/${identifier}`,
  branchName: identifier,
  team: { id: 'team-me', key: 'ME' },
  description: '',
  completed: false,
  canceled: false,
  pullRequests: [],
  blockers: [],
  ...overrides,
});

it.each([
  {
    name: 'skips a merged child for the first ready child',
    slices: [slice('ME-1', { pullRequests: [{ url: 'merged', state: 'MERGED' }] }), slice('ME-2')],
    container: true,
    chosen: 'ME-2',
    statuses: ['merged', 'ready'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'rejects a canceled slice',
    slices: [slice('ME-1', { canceled: true })],
    container: false,
    chosen: undefined,
    statuses: ['canceled'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'reports completed without merged PR',
    slices: [slice('ME-1', { completed: true })],
    container: false,
    chosen: undefined,
    statuses: ['completedWithoutMergedPr'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'reports a blocker without an open or merged PR',
    slices: [slice('ME-1', { blockers: [{ identifier: 'ME-0', pullRequests: [] }] })],
    container: false,
    chosen: undefined,
    statuses: ['blocked'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'chooses a ready named slice',
    slices: [slice('ME-1')],
    container: false,
    chosen: 'ME-1',
    statuses: ['ready'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'reports no ready container slice',
    slices: [slice('ME-1', { canceled: true })],
    container: true,
    chosen: undefined,
    statuses: ['canceled'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'leaves the base for the open blocker chain',
    slices: [
      slice('ME-1', {
        blockers: [{ identifier: 'ME-0', pullRequests: [{ url: 'open', state: 'OPEN' }] }],
      }),
    ],
    container: false,
    chosen: 'ME-1',
    statuses: ['ready'],
    base: null,
    open: ['open'],
  },
  {
    name: 'prefers merged over open blocker PRs',
    slices: [
      slice('ME-1', {
        blockers: [
          {
            identifier: 'ME-0',
            pullRequests: [
              { url: 'open', state: 'OPEN' },
              { url: 'merged', state: 'MERGED' },
            ],
          },
        ],
      }),
    ],
    container: false,
    chosen: 'ME-1',
    statuses: ['ready'],
    base: 'origin/main',
    open: [],
  },
])('$name', ({ slices, container, chosen, statuses, base, open }) => {
  const result = decidePick({ slices, container, defaultBranch: 'main' });

  expect(result.chosen?.identifier).toBe(chosen);
  expect(result.slices.map((candidate) => candidate.status)).toEqual(statuses);
  expect(result.base).toBe(base);
  expect(result.openBlockerPullRequests).toEqual(open);
  expect(result.reason).not.toBe('');
});
