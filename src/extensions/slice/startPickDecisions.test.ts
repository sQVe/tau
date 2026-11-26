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
    slices: [
      slice('ME-1', { pullRequests: [{ url: 'merged', state: 'MERGED', closes: true }] }),
      slice('ME-2'),
    ],
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
        blockers: [
          { identifier: 'ME-0', pullRequests: [{ url: 'open', state: 'OPEN', closes: true }] },
        ],
      }),
    ],
    container: false,
    chosen: 'ME-1',
    statuses: ['ready'],
    base: null,
    open: ['open'],
  },
  {
    name: 'lists only open blocker PRs',
    slices: [
      slice('ME-1', {
        blockers: [
          {
            identifier: 'ME-0',
            pullRequests: [
              { url: 'closed', state: 'CLOSED', closes: true },
              { url: 'open', state: 'OPEN', closes: true },
            ],
          },
        ],
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
              { url: 'open', state: 'OPEN', closes: true },
              { url: 'merged', state: 'MERGED', closes: true },
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
  {
    name: 'does not read a merged mention as landed work',
    slices: [slice('ME-1', { pullRequests: [{ url: 'mention', state: 'MERGED', closes: false }] })],
    container: false,
    chosen: 'ME-1',
    statuses: ['ready'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'does not read a blocker merged mention as a merged blocker',
    slices: [
      slice('ME-1', {
        blockers: [
          {
            identifier: 'ME-0',
            pullRequests: [{ url: 'mention', state: 'MERGED', closes: false }],
          },
        ],
      }),
    ],
    container: false,
    chosen: undefined,
    statuses: ['blocked'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'does not open the blocker chain from a mention',
    slices: [
      slice('ME-1', {
        blockers: [
          { identifier: 'ME-0', pullRequests: [{ url: 'mention', state: 'OPEN', closes: false }] },
        ],
      }),
    ],
    container: false,
    chosen: undefined,
    statuses: ['blocked'],
    base: 'origin/main',
    open: [],
  },
  {
    name: 'lists only closing blocker PRs as the open chain',
    slices: [
      slice('ME-1', {
        blockers: [
          {
            identifier: 'ME-0',
            pullRequests: [
              { url: 'mention', state: 'OPEN', closes: false },
              { url: 'open', state: 'OPEN', closes: true },
            ],
          },
        ],
      }),
    ],
    container: false,
    chosen: 'ME-1',
    statuses: ['ready'],
    base: null,
    open: ['open'],
  },
])('$name', ({ slices, container, chosen, statuses, base, open }) => {
  const result = decidePick({ slices, container, defaultBranch: 'main' });

  expect(result.chosen?.identifier).toBe(chosen);
  expect(result.slices.map((candidate) => candidate.status)).toEqual(statuses);
  expect(result.base).toBe(base);
  expect(result.openBlockerPullRequests).toEqual(open);
  expect(result.reason).not.toBe('');
});

it('keeps a slice pull request that only mentions it in the chosen links', () => {
  const mention = { url: 'mention', state: 'OPEN', closes: false };

  const result = decidePick({
    slices: [slice('ME-1', { pullRequests: [mention] })],
    container: false,
    defaultBranch: 'main',
  });

  expect(result.chosen?.pullRequests).toEqual(['mention']);
});
