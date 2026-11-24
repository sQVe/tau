import { expect, it } from 'vitest';

import {
  startFenceCancellable,
  startFenceMarkerToDelete,
  startFenceTicketFact,
} from './startFenceDecision.js';
import type { StartFenceCleanupFacts, StartFencePhase } from './startFenceDecision.js';

const cleanup = (overrides: Partial<StartFenceCleanupFacts>): StartFenceCleanupFacts => ({
  kept: false,
  ticket: 'taken',
  child: 'gone',
  processId: 41,
  ...overrides,
});

it.each<{ phase: StartFencePhase; expected: boolean }>([
  { phase: 'noTicket', expected: false },
  { phase: 'active', expected: true },
  { phase: 'cancelled', expected: false },
  { phase: 'unread', expected: false },
  { phase: 'started', expected: true },
  { phase: 'takenWithoutProcess', expected: true },
])('decides whether the $phase phase can still be cancelled', ({ phase, expected }) => {
  expect(startFenceCancellable(phase)).toBe(expected);
});

it.each<{ phase: StartFencePhase; expected: string }>([
  { phase: 'noTicket', expected: 'notCreated' },
  { phase: 'active', expected: 'taken' },
  { phase: 'cancelled', expected: 'cancelled' },
  { phase: 'unread', expected: 'unread' },
  { phase: 'started', expected: 'taken' },
  { phase: 'takenWithoutProcess', expected: 'taken' },
])('reports the $phase phase as $expected to the release decision', ({ phase, expected }) => {
  expect(startFenceTicketFact(phase)).toBe(expected);
});

it.each<{ name: string; facts: StartFenceCleanupFacts; expected: number | undefined }>([
  {
    name: 'a released claim whose started child is gone',
    facts: cleanup({}),
    expected: 41,
  },
  {
    name: 'a kept claim',
    facts: cleanup({ kept: true }),
    expected: undefined,
  },
  {
    name: 'a cancelled ticket',
    facts: cleanup({ ticket: 'cancelled' }),
    expected: undefined,
  },
  {
    name: 'a child that may still run',
    facts: cleanup({ child: 'running' }),
    expected: undefined,
  },
  {
    name: 'a child whose state is unknown',
    facts: cleanup({ child: 'unknown' }),
    expected: undefined,
  },
  {
    name: 'a taken marker with no usable process id',
    facts: cleanup({ child: 'unknown', processId: undefined }),
    expected: undefined,
  },
])('deletes the marker only for $name', ({ facts, expected }) => {
  expect(startFenceMarkerToDelete(facts)).toBe(expected);
});
