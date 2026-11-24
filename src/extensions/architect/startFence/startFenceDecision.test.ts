import { expect, it } from 'vitest';

import { startFenceCompletionDecision, startFenceTakeoverDecision } from './startFenceDecision.js';
import type {
  StartFenceCompletionFacts,
  StartFenceCompletionPlan,
  StartFenceTakeoverFacts,
  StartFenceTakeoverProgress,
} from './startFenceDecision.js';

const completion = (overrides: Partial<StartFenceCompletionFacts>): StartFenceCompletionFacts => ({
  ticket: 'taken',
  child: 'gone',
  adopted: false,
  processId: 41,
  ...overrides,
});

it.each<{ name: string; facts: StartFenceCompletionFacts; expected: StartFenceCompletionPlan }>([
  {
    name: 'a ticket that was never created',
    facts: completion({ ticket: 'notCreated', child: 'unknown' }),
    expected: { outcome: 'cancelled', claim: 'release', marker: 'keep' },
  },
  {
    name: 'a cancelled ticket',
    facts: completion({ ticket: 'cancelled', child: 'unknown' }),
    expected: { outcome: 'cancelled', claim: 'release', marker: 'keep' },
  },
  {
    name: 'an unread cancel',
    facts: completion({ ticket: 'unread', child: 'running' }),
    expected: { outcome: 'unresolved', claim: 'keep', marker: 'keep' },
  },
  {
    name: 'a gone child',
    facts: completion({ child: 'gone' }),
    expected: { outcome: 'gone', claim: 'release', marker: 'delete' },
  },
  {
    name: 'a gone child whose process id is unknown',
    facts: completion({ child: 'gone', processId: undefined }),
    expected: { outcome: 'gone', claim: 'release', marker: 'keep' },
  },
  {
    name: 'a gone child that had adopted',
    facts: completion({ child: 'gone', adopted: true }),
    expected: { outcome: 'gone', claim: 'release', marker: 'delete' },
  },
  {
    name: 'an adopted running child',
    facts: completion({ child: 'running', adopted: true }),
    expected: { outcome: 'adopted', claim: 'release', marker: 'keep' },
  },
  {
    name: 'an adopted child whose state is unknown',
    facts: completion({ child: 'unknown', adopted: true }),
    expected: { outcome: 'adopted', claim: 'release', marker: 'keep' },
  },
  {
    name: 'a running child that has not adopted',
    facts: completion({ child: 'running' }),
    expected: { outcome: 'unresolved', claim: 'keep', marker: 'keep' },
  },
  {
    name: 'a child whose state is unknown and that has not adopted',
    facts: completion({ child: 'unknown', processId: undefined }),
    expected: { outcome: 'unresolved', claim: 'keep', marker: 'keep' },
  },
])('completes $name as $expected.outcome with the claim $expected.claim', ({ facts, expected }) => {
  expect(startFenceCompletionDecision(facts)).toEqual(expected);
});

const takeover = (overrides: Partial<StartFenceTakeoverFacts>): StartFenceTakeoverFacts => ({
  adopted: false,
  gone: false,
  now: 0,
  deadline: 1_000,
  cancelled: false,
  ...overrides,
});

it.each<{ name: string; facts: StartFenceTakeoverFacts; expected: StartFenceTakeoverProgress }>([
  {
    name: 'adoption over a cancel',
    facts: takeover({ adopted: true, cancelled: true }),
    expected: 'adopted',
  },
  {
    name: 'adoption over a gone child',
    facts: takeover({ adopted: true, gone: true }),
    expected: 'adopted',
  },
  {
    name: 'a cancel before the deadline',
    facts: takeover({ cancelled: true }),
    expected: 'cancelled',
  },
  {
    name: 'the deadline',
    facts: takeover({ now: 1_000 }),
    expected: 'expired',
  },
  {
    name: 'a deadline past a gone child',
    facts: takeover({ gone: true, now: 1_001 }),
    expected: 'expired',
  },
  {
    name: 'a gone child before the deadline',
    facts: takeover({ gone: true }),
    expected: 'gone',
  },
  {
    name: 'a live child before the deadline',
    facts: takeover({}),
    expected: 'waiting',
  },
])('waits for the takeover until $name', ({ facts, expected }) => {
  expect(startFenceTakeoverDecision(facts)).toBe(expected);
});
