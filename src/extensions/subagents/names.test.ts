import { expect, it } from 'vitest';

import { fixtureLoadout } from './fixtures/loadout.js';
import { allocateName } from './names.js';

const allocation = (retained: string[], live: unknown[] = []) => {
  const suffixes = ['ab', 'cd'];

  return {
    retained,
    loadout: { ...fixtureLoadout('/work'), profile: 'scout', role: 'investigation' as const },
    live,
    suffix: () => suffixes.shift() ?? 'zz',
  };
};

it.each([
  { taken: 'nothing', retained: [], live: [], name: 'scout-ab' },
  { taken: 'a saved name', retained: ['scout-ab'], live: [], name: 'scout-cd' },
  {
    taken: 'a live name',
    retained: [],
    live: [{ pane_id: 'other', name: 'scout-ab' }],
    name: 'scout-cd',
  },
])('allocates $name when $taken is taken', ({ retained, live, name }) => {
  expect(allocateName(allocation(retained, live))).toBe(name);
});
