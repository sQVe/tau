import { expect, it } from 'vitest';

import { decideOwnership } from './ownershipDecision.js';
import type { OwnershipFacts } from './ownershipDecision.js';

const cases: { name: string; facts: OwnershipFacts; status: string }[] = [
  { name: 'PR by viewer', facts: { kind: 'pr', author: 'me', viewer: 'me' }, status: 'own' },
  { name: 'PR by another', facts: { kind: 'pr', author: 'them', viewer: 'me' }, status: 'other' },
  {
    name: 'all own commits',
    facts: { kind: 'commits', emails: ['me', 'me'], email: 'me' },
    status: 'own',
  },
  {
    name: 'all other commits',
    facts: { kind: 'commits', emails: ['them'], email: 'me' },
    status: 'other',
  },
  {
    name: 'mixed commits',
    facts: { kind: 'commits', emails: ['me', 'them'], email: 'me' },
    status: 'unclear',
  },
  { name: 'no commits', facts: { kind: 'commits', emails: [], email: 'me' }, status: 'own' },
  ...['PR', 'viewer', 'email', 'commits'].map((name) => ({
    name: `failed ${name}`,
    facts: { kind: 'failed' as const, reason: `${name} failed` },
    status: 'unclear',
  })),
];

it.each(cases)('decides ownership for $name', ({ facts, status }) => {
  const result = decideOwnership(facts);

  const anyReason: unknown = expect.any(String);
  const reason = facts.kind === 'failed' ? facts.reason : anyReason;
  const reasons = status === 'unclear' ? [reason] : [];

  expect(result).toEqual({ status, reasons });
});
