import { expect, it } from 'vitest';

import { endsArchitect } from './shutdownDecision.js';

it.each([
  { reason: 'quit', ends: true },
  { reason: 'reload', ends: false },
  { reason: 'new', ends: true },
  { reason: 'resume', ends: true },
  { reason: 'fork', ends: true },
] as const)('a $reason shutdown ends the architect: $ends', ({ reason, ends }) => {
  expect(endsArchitect(reason)).toBe(ends);
});
