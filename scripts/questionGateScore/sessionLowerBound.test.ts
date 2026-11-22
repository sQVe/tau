import { expect, it } from 'vitest';

import { sessionSummary } from './sessionLowerBound.ts';

const observations = (session: string, hits: number, misses: number) => [
  ...Array.from({ length: hits }, () => ({ session, hit: true })),
  ...Array.from({ length: misses }, () => ({ session, hit: false })),
];

it('weights sessions by decided questions rather than averaging sessions', () => {
  const summary = sessionSummary([
    ...observations('many-hits', 10, 0),
    ...observations('some-hits', 10, 0),
    ...observations('few-misses', 0, 2),
  ]);

  expect(summary.decided).toBe(22);
  expect(summary.hits).toBe(20);
  expect(summary.sessions).toBe(3);
  expect(summary.lowerBound).toBeCloseTo(0.1145, 3);
});

it('returns zero for no observations', () => {
  expect(sessionSummary([]).lowerBound).toBe(0);
});

it('returns zero for one session with many hits', () => {
  expect(sessionSummary(observations('one', 73, 0)).lowerBound).toBe(0);
});
