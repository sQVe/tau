import { expect, it } from 'vitest';

import { commandIsIdle } from './idleDecision.js';

it.each([
  { name: 'just wrote', now: 1000, lastOutputAt: 1000, expected: false },
  { name: 'one millisecond before the limit', now: 1599, lastOutputAt: 1000, expected: false },
  { name: 'exactly at the limit', now: 1600, lastOutputAt: 1000, expected: true },
  { name: 'past the limit', now: 5000, lastOutputAt: 1000, expected: true },
])('$name', ({ now, lastOutputAt, expected }) => {
  expect(commandIsIdle({ now, lastOutputAt, idleLimitMilliseconds: 600 })).toBe(expected);
});
