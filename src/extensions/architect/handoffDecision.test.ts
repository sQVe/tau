import { expect, it } from 'vitest';

import { startClaim } from './handoffDecision.js';
import type { StartClaim, StartClaimFacts } from './handoffDecision.js';

const table: { name: string; facts: StartClaimFacts; expected: StartClaim }[] = [
  {
    name: 'holds the lock when no claim names a checkout',
    facts: { claimToken: undefined, handoffRoot: undefined, root: '/repo-a' },
    expected: { kind: 'hold' },
  },
  {
    name: 'holds the lock when a handoff root has no claim token',
    facts: { claimToken: undefined, handoffRoot: '/repo-a', root: '/repo-a' },
    expected: { kind: 'hold' },
  },
  {
    name: 'adopts a claim with no handoff root',
    facts: { claimToken: 'token-a', handoffRoot: undefined, root: '/repo-a' },
    expected: { kind: 'adopt', token: 'token-a' },
  },
  {
    name: 'adopts the claim of a handoff in the same checkout',
    facts: { claimToken: 'token-a', handoffRoot: '/repo-a', root: '/repo-a' },
    expected: { kind: 'adopt', token: 'token-a' },
  },
  {
    name: 'leaves the old checkout when the handoff root is another checkout',
    facts: { claimToken: 'token-a', handoffRoot: '/repo-b', root: '/repo-a' },
    expected: { kind: 'leave', previousRoot: '/repo-b', token: 'token-a' },
  },
];

it.each(table.map((row) => [row.name, row] as const))('%s', (_name, row) => {
  expect(startClaim(row.facts)).toEqual(row.expected);
});
