import { expect, it } from 'vitest';

import { openStartProgress } from './openStartClaimDecision.js';

it.each([
  {
    name: 'an adopted child',
    adopted: true,
    now: 0,
    deadline: 60_000,
    cancelled: false,
    expected: 'taken',
  },
  {
    name: 'an adopted child on a cancelled call',
    adopted: true,
    now: 0,
    deadline: 60_000,
    cancelled: true,
    expected: 'taken',
  },
  {
    name: 'no adoption before the deadline',
    adopted: false,
    now: 59_999,
    deadline: 60_000,
    cancelled: false,
    expected: 'waiting',
  },
  {
    name: 'no adoption at the deadline',
    adopted: false,
    now: 60_000,
    deadline: 60_000,
    cancelled: false,
    expected: 'expired',
  },
  {
    name: 'no adoption after the deadline',
    adopted: false,
    now: 60_001,
    deadline: 60_000,
    cancelled: false,
    expected: 'expired',
  },
  {
    name: 'no adoption before the deadline on a cancelled call',
    adopted: false,
    now: 59_999,
    deadline: 60_000,
    cancelled: true,
    expected: 'cancelled',
  },
  {
    name: 'no adoption after the deadline on a cancelled call',
    adopted: false,
    now: 60_001,
    deadline: 60_000,
    cancelled: true,
    expected: 'cancelled',
  },
])('decides the start progress for $name', ({ adopted, now, deadline, cancelled, expected }) => {
  expect(openStartProgress({ adopted, now, deadline, cancelled })).toBe(expected);
});
