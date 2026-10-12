import { expect, it } from 'vitest';

import { acceptanceRefusal } from './acceptanceRefusal.js';

it.each([
  { role: 'editing', acceptance: undefined, refused: true },
  { role: 'editing', acceptance: [], refused: true },
  { role: 'editing', acceptance: ['  '], refused: true },
  { role: 'editing', acceptance: ['a', ''], refused: true },
  { role: 'editing', acceptance: ['a'], refused: false },
  { role: 'investigation', acceptance: undefined, refused: false },
  { role: 'investigation', acceptance: [], refused: false },
] as const)('$role with $acceptance refused: $refused', ({ role, acceptance, refused }) => {
  expect(acceptanceRefusal(role, acceptance) !== undefined).toBe(refused);
});
