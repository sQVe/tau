import { expect, it } from 'vitest';

import { holdsArrival } from './arrivalDecision.js';

const table = [
  { name: 'an idle session', facts: { runActive: false, signal: 'none' }, holds: false },
  { name: 'a streaming run', facts: { runActive: true, signal: 'live' }, holds: false },
  { name: 'a run being aborted', facts: { runActive: true, signal: 'aborted' }, holds: true },
  {
    name: 'a run after its agent loop ended',
    facts: { runActive: true, signal: 'none' },
    holds: true,
  },
] as const;

it.each(table.map((row) => [row.name, row] as const))(
  'decides whether to hold an arrival in %s',
  (_name, row) => {
    expect(holdsArrival(row.facts)).toBe(row.holds);
  },
);
