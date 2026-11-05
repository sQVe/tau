import { expect, it } from 'vitest';

import { judgeLease } from './leaseDecision.js';

it.each([
  { case: 'a live lease', label: 'session-1:2000', now: 1000, kind: 'live' },
  { case: 'a lease that expires now', label: 'session-1:1000', now: 1000, kind: 'expired' },
  { case: 'an expired lease', label: 'session-1:999', now: 1000, kind: 'expired' },
  { case: 'a missing lease', label: undefined, now: 1000, kind: 'absent' },
  { case: 'an empty lease', label: '', now: 1000, kind: 'malformed' },
  { case: 'a lease without a separator', label: 'session-1', now: 1000, kind: 'malformed' },
  { case: 'a lease with an empty session', label: ':1000', now: 0, kind: 'malformed' },
  { case: 'a lease with an empty expiry', label: 'session-1:', now: 1000, kind: 'malformed' },
  {
    case: 'a lease with an oversized session',
    label: `${'s'.repeat(501)}:2000`,
    now: 1000,
    kind: 'malformed',
  },
  {
    case: 'a lease with a session at the limit',
    label: `${'s'.repeat(500)}:2000`,
    now: 1000,
    kind: 'live',
  },
  {
    case: 'a lease with a non-numeric expiry',
    label: 'session-1:soon',
    now: 1000,
    kind: 'malformed',
  },
  {
    case: 'a lease with a fractional expiry',
    label: 'session-1:1.5',
    now: 0,
    kind: 'malformed',
  },
  {
    case: 'a lease with an infinite expiry',
    label: 'session-1:Infinity',
    now: 0,
    kind: 'malformed',
  },
])('judges $case as $kind', ({ label, now, kind }) => {
  expect(judgeLease(label, now).kind).toBe(kind);
});

it('keeps the session id and expiry of a live lease', () => {
  expect(judgeLease('session-1:2000', 1000)).toEqual({
    kind: 'live',
    sessionId: 'session-1',
    expiresAt: 2000,
  });
});
