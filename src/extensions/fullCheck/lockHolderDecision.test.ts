import { expect, it } from 'vitest';

import { holderIsGone } from './lockHolderDecision.js';
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
