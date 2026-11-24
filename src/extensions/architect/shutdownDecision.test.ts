import { expect, it } from 'vitest';

import { endsArchitect, keepsLock } from './shutdownDecision.js';

it.each([
  { reason: 'quit', ends: true },
  { reason: 'reload', ends: false },
  { reason: 'new', ends: true },
  { reason: 'resume', ends: true },
  { reason: 'fork', ends: true },
] as const)('a $reason shutdown ends the architect: $ends', ({ reason, ends }) => {
  expect(endsArchitect(reason)).toBe(ends);
});

it.each([
  { reason: 'quit', keeps: false },
  { reason: 'reload', keeps: true },
  { reason: 'new', keeps: true },
  { reason: 'resume', keeps: true },
  { reason: 'fork', keeps: true },
] as const)('a $reason shutdown keeps the architect lock: $keeps', ({ reason, keeps }) => {
  expect(keepsLock(reason)).toBe(keeps);
});
