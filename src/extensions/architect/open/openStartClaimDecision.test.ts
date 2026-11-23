import { expect, it } from 'vitest';

import { openStartProgress } from './openStartClaimDecision.js';

const claimToken = 'claim';

it.each([
  {
    name: 'no live holder',
    holderToken: undefined,
    now: 0,
    deadline: 60_000,
    expected: 'taken',
  },
  {
    name: 'another holder token',
    holderToken: 'pi',
    now: 0,
    deadline: 60_000,
    expected: 'taken',
  },
  {
    name: 'the claim before the deadline',
    holderToken: claimToken,
    now: 59_999,
    deadline: 60_000,
    expected: 'waiting',
  },
  {
    name: 'the claim at the deadline',
    holderToken: claimToken,
    now: 60_000,
    deadline: 60_000,
    expected: 'expired',
  },
  {
    name: 'the claim after the deadline',
    holderToken: claimToken,
    now: 60_001,
    deadline: 60_000,
    expected: 'expired',
  },
])('decides the start progress for $name', ({ holderToken, now, deadline, expected }) => {
  expect(openStartProgress({ claimToken, holderToken, now, deadline })).toBe(expected);
});
