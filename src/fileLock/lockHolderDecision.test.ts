import { expect, it } from 'vitest';

import {
  claimIsAdoptable,
  holderIsGone,
  holderIsTakeable,
  recordNeedsRereading,
} from './lockHolderDecision.js';
import type { LockHolderFacts } from './lockHolderDecision.js';

const facts = (overrides: Partial<LockHolderFacts>): LockHolderFacts => ({
  recorded: true,
  released: false,
  sessionAlive: true,
  commandAlive: false,
  ...overrides,
});

it.each([
  { name: 'released', facts: facts({ released: true }), expected: true },
  {
    name: 'released with a live session and command',
    facts: facts({ released: true, commandAlive: true }),
    expected: true,
  },
  {
    name: 'missing holder',
    facts: facts({ recorded: false, sessionAlive: false }),
    expected: true,
  },
  { name: 'live session', facts: facts({}), expected: false },
  {
    name: 'live session and command',
    facts: facts({ commandAlive: true }),
    expected: false,
  },
  {
    name: 'dead session with a live command',
    facts: facts({ sessionAlive: false, commandAlive: true }),
    expected: false,
  },
  {
    name: 'dead session with no command',
    facts: facts({ sessionAlive: false, commandAlive: false }),
    expected: true,
  },
])('decides whether the holder is gone for $name', ({ facts: holderFacts, expected }) => {
  expect(holderIsGone(holderFacts)).toBe(expected);
});

it.each([
  { name: 'dead session with no command', facts: facts({ sessionAlive: false }), expected: true },
  {
    name: 'dead session with a live command',
    facts: facts({ sessionAlive: false, commandAlive: true }),
    expected: false,
  },
  { name: 'live session', facts: facts({}), expected: false },
  { name: 'released', facts: facts({ released: true, sessionAlive: false }), expected: false },
  {
    name: 'missing holder',
    facts: facts({ recorded: false, sessionAlive: false }),
    expected: false,
  },
])('decides whether to read the record again for $name', ({ facts: holderFacts, expected }) => {
  expect(recordNeedsRereading(holderFacts)).toBe(expected);
});

it.each([
  {
    name: 'no adopt token',
    holderToken: 'claim',
    released: false,
    adoptToken: undefined,
    expected: false,
  },
  {
    name: 'the claim token',
    holderToken: 'claim',
    released: false,
    adoptToken: 'claim',
    expected: true,
  },
  {
    name: 'another token',
    holderToken: 'claim',
    released: false,
    adoptToken: 'other',
    expected: false,
  },
  {
    name: 'a released claim',
    holderToken: 'claim',
    released: true,
    adoptToken: 'claim',
    expected: false,
  },
  {
    name: 'no holder token and no adopt token',
    holderToken: '',
    released: false,
    adoptToken: '',
    expected: false,
  },
  {
    name: 'neither a holder token nor an adopt token',
    holderToken: undefined,
    released: false,
    adoptToken: undefined,
    expected: false,
  },
])('decides whether $name is adoptable', ({ holderToken, released, adoptToken, expected }) => {
  expect(claimIsAdoptable({ holderToken, released, adoptToken })).toBe(expected);
});

it.each([
  {
    name: 'a missing holder without an adopt token',
    facts: facts({ recorded: false, sessionAlive: false }),
    holderToken: undefined,
    adoptToken: undefined,
    expected: true,
  },
  {
    name: 'a live holder without an adopt token',
    facts: facts({}),
    holderToken: 'claim',
    adoptToken: undefined,
    expected: false,
  },
  {
    name: 'a released holder without an adopt token',
    facts: facts({ released: true }),
    holderToken: 'claim',
    adoptToken: undefined,
    expected: true,
  },
  {
    name: 'a live holder with the adopt token',
    facts: facts({}),
    holderToken: 'claim',
    adoptToken: 'claim',
    expected: true,
  },
  {
    name: 'a released holder with the adopt token',
    facts: facts({ released: true }),
    holderToken: 'claim',
    adoptToken: 'claim',
    expected: false,
  },
  {
    name: 'a replaced holder with the adopt token',
    facts: facts({}),
    holderToken: 'other',
    adoptToken: 'claim',
    expected: false,
  },
  {
    name: 'a missing holder with the adopt token',
    facts: facts({ recorded: false, sessionAlive: false }),
    holderToken: undefined,
    adoptToken: 'claim',
    expected: false,
  },
  {
    name: 'an empty adopt token on a live holder',
    facts: facts({}),
    holderToken: 'claim',
    adoptToken: '',
    expected: false,
  },
  {
    name: 'an empty adopt token on a released holder',
    facts: facts({ released: true }),
    holderToken: 'claim',
    adoptToken: '',
    expected: true,
  },
])(
  'decides whether the holder is takeable for $name',
  ({ facts: holderFacts, holderToken, adoptToken, expected }) => {
    expect(holderIsTakeable({ facts: holderFacts, holderToken, adoptToken })).toBe(expected);
  },
);
