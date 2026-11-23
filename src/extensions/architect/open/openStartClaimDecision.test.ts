import { expect, it } from 'vitest';

import { openStartProgress } from './openStartClaimDecision.js';

const claimToken = 'claim';

it.each([
  {
    name: 'no live holder',
    holderToken: undefined,
    now: 0,
    deadline: 60_000,
    cancelled: false,
    expected: 'taken',
  },
  {
    name: 'another holder token',
    holderToken: 'pi',
    now: 0,
    deadline: 60_000,
    cancelled: false,
    expected: 'taken',
  },
  {
    name: 'another holder token on a cancelled call',
    holderToken: 'pi',
    now: 0,
    deadline: 60_000,
    cancelled: true,
    expected: 'taken',
  },
  {
    name: 'the claim before the deadline',
    holderToken: claimToken,
    now: 59_999,
    deadline: 60_000,
    cancelled: false,
    expected: 'waiting',
  },
  {
    name: 'the claim at the deadline',
    holderToken: claimToken,
    now: 60_000,
    deadline: 60_000,
    cancelled: false,
    expected: 'expired',
  },
  {
    name: 'the claim after the deadline',
    holderToken: claimToken,
    now: 60_001,
    deadline: 60_000,
    cancelled: false,
    expected: 'expired',
  },
  {
    name: 'the claim before the deadline on a cancelled call',
    holderToken: claimToken,
    now: 59_999,
    deadline: 60_000,
    cancelled: true,
    expected: 'cancelled',
  },
  {
    name: 'the claim after the deadline on a cancelled call',
    holderToken: claimToken,
    now: 60_001,
    deadline: 60_000,
    cancelled: true,
    expected: 'cancelled',
  },
])(
  'decides the start progress for $name',
  ({ holderToken, now, deadline, cancelled, expected }) => {
    expect(openStartProgress({ claimToken, holderToken, now, deadline, cancelled })).toBe(expected);
  },
);
