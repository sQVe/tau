import { describe, expect, it } from 'vitest';

import type { Draft } from './draft.js';
import { describeWrite, isInPlanOrder, planWrites, plannedSortOrders } from './writes.js';
import type { LinearChild, LinearContainer, OrderedSlice } from './writes.js';

const draft = (identifiers: (string | null)[], blockedBy: number[][] = []): Draft => ({
  plan: {
    version: 1,
    route: { team: 'ME', project: 'Tau' },
    container: { identifier: 'ME-1', title: 'Container', file: 'container.md' },
    slices: identifiers.map((identifier, index) => ({
      identifier,
      title: `Slice ${index + 1}`,
      file: `slice-${index + 1}.md`,
      blockedBy: blockedBy[index] ?? [],
    })),
  },
  containerBody: 'Design',
  sliceBodies: identifiers.map((_, index) => `Body ${index + 1}`),
});

const child = (number: number, change: Partial<LinearChild> = {}): LinearChild => ({
  identifier: `ME-${number + 1}`,
  title: `Slice ${number}`,
  description: `Body ${number}`,
  url: '',
  sortOrder: number,
  completed: false,
  canceled: false,
  merged: false,
  blockedBy: [],
  ...change,
});

const container = (
  children: LinearChild[],
  change: Partial<LinearContainer> = {},
): LinearContainer => ({
  id: 'id-ME-1',
  identifier: 'ME-1',
  completed: false,
  merged: false,
  title: 'Container',
  description: 'Design',
  url: '',
  team: { id: 'team', key: 'ME' },
  project: { id: 'project', name: 'Tau' },
  children,
  ...change,
});

describe('planWrites', () => {
  it.each([
    {
      case: 'no container yet',
      draft: draft([null, null], [[], [1]]),
      container: undefined,
      writes: [
        { kind: 'createContainer' },
        { kind: 'createSlice', number: 1, sortOrder: 0 },
        { kind: 'createSlice', number: 2, sortOrder: 1 },
        { kind: 'addBlockedBy', number: 2, blocker: 1 },
      ],
      problems: [],
    },
    {
      case: 'open issue with the container title',
      draft: draft([null]),
      container: undefined,
      titleMatches: ['ME-9'],
      writes: [{ kind: 'createContainer' }, { kind: 'createSlice', number: 1, sortOrder: 0 }],
      problems: [expect.stringMatching(/^The draft has no container identifier, but ME-9/)],
    },
    {
      case: 'slice blocked by a later new slice',
      draft: draft([null, null], [[2], []]),
      container: container([]),
      writes: [
        { kind: 'createSlice', number: 1, sortOrder: 0 },
        { kind: 'createSlice', number: 2, sortOrder: 1 },
        { kind: 'addBlockedBy', number: 1, blocker: 2 },
      ],
      problems: [],
    },
    {
      case: 'merged one-slice ticket with changes',
      draft: draft([]),
      container: container([], { merged: true, completed: true, title: 'Old' }),
      writes: [],
      problems: [],
    },
    {
      case: 'completed one-slice ticket without a merged PR that would change',
      draft: draft([]),
      container: container([], { completed: true, description: 'Old' }),
      writes: [{ kind: 'updateContainer', identifier: 'ME-1', title: false, description: true }],
      problems: [expect.stringMatching(/^ME-1 is completed in Linear/)],
    },
    {
      case: 'everything matches',
      draft: draft(['ME-2', 'ME-3'], [[], [1]]),
      container: container([child(1), child(2, { blockedBy: ['ME-2'] })]),
      writes: [],
      problems: [],
    },
    {
      case: 'retry creates only the unrecorded slice',
      draft: draft(['ME-2', null]),
      container: container([child(1)]),
      writes: [{ kind: 'createSlice', number: 2, sortOrder: 2 }],
      problems: [],
    },
    {
      case: 'slice out of plan order',
      draft: draft(['ME-2', 'ME-3']),
      container: container([child(1, { sortOrder: 5 }), child(2)]),
      writes: [{ kind: 'moveSlice', identifier: 'ME-3', sortOrder: 6 }],
      problems: [],
    },
    {
      case: 'changed body of an unmerged slice',
      draft: draft(['ME-2']),
      container: container([child(1, { description: 'Old' })]),
      writes: [
        { kind: 'updateSlice', number: 1, identifier: 'ME-2', title: false, description: true },
      ],
      problems: [],
    },
    {
      case: 'changed container title',
      draft: draft([]),
      container: container([], { title: 'Old' }),
      writes: [{ kind: 'updateContainer', identifier: 'ME-1', title: true, description: false }],
      problems: [],
    },
    {
      case: 'merged slice with changes',
      draft: draft(['ME-2', 'ME-3'], [[], []]),
      container: container([
        child(1, { merged: true, completed: true, description: 'Old' }),
        child(2, { merged: true, blockedBy: ['ME-2'] }),
      ]),
      writes: [],
      problems: [],
    },
    {
      case: 'dropped dependency between siblings',
      draft: draft(['ME-2', 'ME-3']),
      container: container([child(1), child(2, { blockedBy: ['ME-2', 'OTHER-9'] })]),
      writes: [{ kind: 'removeBlockedBy', identifier: 'ME-3', blocker: 'ME-2' }],
      problems: [],
    },
    {
      case: 'completed slice without a merged PR that would change',
      draft: draft(['ME-2']),
      container: container([child(1, { completed: true, title: 'Old' })]),
      writes: [
        { kind: 'updateSlice', number: 1, identifier: 'ME-2', title: true, description: false },
      ],
      problems: [expect.stringMatching(/^ME-2 is completed in Linear/)],
    },
    {
      case: 'unrecorded slice with the title of a child',
      draft: draft([null]),
      container: container([child(1)]),
      writes: [{ kind: 'createSlice', number: 1, sortOrder: 0 }],
      problems: [expect.stringMatching(/^Slice 1 has no identifier, but ME-2/)],
    },
    {
      case: 'recorded identifier that is not a child',
      draft: draft(['ME-8']),
      container: container([]),
      writes: [{ kind: 'createSlice', number: 1, sortOrder: 0 }],
      problems: [expect.stringMatching(/^Slice 1 records ME-8, which is not a child/)],
    },
    {
      case: 'container in another project',
      draft: draft([]),
      container: container([], { project: null }),
      writes: [],
      problems: [
        expect.stringMatching(
          /team ME and no project, but the draft routes to team ME and project Tau/,
        ),
      ],
    },
  ])('$case', ({ draft: saved, container: linear, titleMatches, writes, problems }) => {
    const plan = planWrites(saved, linear, titleMatches ?? []);

    expect(plan.writes).toEqual(writes);
    expect(plan.problems).toEqual(problems);
  });

  it('lists children the plan leaves out as dropped', () => {
    const plan = planWrites(draft(['ME-2']), container([child(1), child(5)]), []);

    expect(plan.dropped).toEqual(['ME-6']);
  });

  it('leaves canceled children out of dropped', () => {
    const children = [child(1), child(5, { canceled: true }), child(6)];
    const plan = planWrites(draft(['ME-2']), container(children), []);

    expect(plan.dropped).toEqual(['ME-7']);
  });
});

describe('describeWrite', () => {
  it('says that a container create has no project when the route names none', () => {
    const { plan } = draft([]);

    plan.route.project = null;

    expect(describeWrite(plan, { kind: 'createContainer' })).toMatch(/with no project/);
  });
});

const ordered = (
  sortOrder: number,
  merged = false,
  identifier = `ME-${sortOrder}`,
  completed = merged,
) => ({
  identifier,
  sortOrder,
  merged,
  completed,
});

const applyOrders = (slices: (OrderedSlice | undefined)[]) => {
  const orders = plannedSortOrders(slices);

  return slices.map((slice, index) => ({
    identifier: slice?.identifier ?? `new-${index}`,
    merged: slice?.merged ?? false,
    completed: slice?.completed ?? false,
    sortOrder: orders[index] ?? slice?.sortOrder ?? Number.NaN,
  }));
};

describe('plannedSortOrders', () => {
  it.each([
    { case: 'in order', slices: [ordered(1), ordered(2)], orders: [undefined, undefined] },
    {
      case: 'swapped unmerged slices',
      slices: [ordered(2, false, 'A'), ordered(1, false, 'B')],
      orders: [undefined, 3],
    },
    {
      case: 'open slice before a merged one',
      slices: [ordered(5, false, 'A'), ordered(3, true, 'B')],
      orders: [2, undefined],
    },
    {
      case: 'unmerged slice between merged neighbors',
      slices: [ordered(1, true, 'A'), ordered(9, false, 'B'), ordered(3, true, 'C')],
      orders: [undefined, 2, undefined],
    },
    {
      case: 'completed slice without merged PR',
      slices: [ordered(5, false, 'A'), ordered(3, false, 'B', true)],
      orders: [2, undefined],
    },
    {
      case: 'merged slices out of order stay',
      slices: [ordered(3, true, 'A'), ordered(1, true, 'B')],
      orders: [undefined, undefined],
    },
    { case: 'new slices only', slices: [undefined, undefined], orders: [0, 1] },
    {
      case: 'new slice between slices in order',
      slices: [ordered(1, false, 'A'), undefined, ordered(2, false, 'B')],
      orders: [undefined, 1.5, undefined],
    },
    {
      case: 'new slice first',
      slices: [undefined, ordered(1, false, 'A')],
      orders: [0, undefined],
    },
    {
      case: 'new slice before a slice out of place',
      slices: [ordered(5, false, 'A'), undefined, ordered(1, false, 'B')],
      orders: [undefined, 6, 7],
    },
    {
      case: 'moved slice below the next slice that stays',
      slices: [ordered(1, false, 'A'), ordered(0, false, 'B'), ordered(1.5, false, 'C')],
      orders: [undefined, 1.25, undefined],
    },
  ])('$case', ({ slices, orders }) => {
    expect(plannedSortOrders(slices)).toEqual(orders);
  });

  it.each([
    [[ordered(2, false, 'A'), ordered(1, false, 'B'), ordered(0, false, 'C')]],
    [[ordered(4, false, 'A'), ordered(1, true, 'B'), ordered(2, false, 'C')]],
    [[undefined, ordered(2, false, 'A'), undefined, ordered(1, false, 'B'), undefined]],
    [[ordered(3, true, 'A'), undefined, ordered(4, true, 'B'), undefined]],
  ])('puts unmerged slices in plan order', (slices) => {
    expect(isInPlanOrder(applyOrders(slices))).toBe(true);
  });
});
