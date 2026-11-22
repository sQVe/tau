import { expect, it } from 'vitest';

import { sessionLowerBound } from './sessionLowerBound.ts';
import type { SessionTally } from './sessionLowerBound.ts';

const bar = 0.95;

const oneHitSessions = (count: number): SessionTally[] =>
  Array.from({ length: count }, () => ({ decided: 1, hits: 1 }));

it.for<[string, SessionTally[], { isZero: boolean; meetsBar: boolean }]>([
  ['no tallies', [], { isZero: true, meetsBar: false }],
  ['one session with 73 hits', [{ decided: 73, hits: 73 }], { isZero: true, meetsBar: false }],
  ['600 sessions with one hit each', oneHitSessions(600), { isZero: false, meetsBar: true }],
  ['599 sessions with one hit each', oneHitSessions(599), { isZero: false, meetsBar: false }],
])('computes the session lower bound: %s', ([, tallies, expected]) => {
  const bound = sessionLowerBound(tallies);

  expect({ isZero: bound === 0, meetsBar: bound >= bar }).toEqual(expected);
});
