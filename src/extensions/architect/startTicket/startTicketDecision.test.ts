import { expect, it } from 'vitest';

import { sweepAction } from './startTicketDecision.js';
import type { SweepAction, SweepFacts } from './startTicketDecision.js';

it.each<{ name: string; facts: SweepFacts; expected: SweepAction }>([
  {
    name: 'an unused ticket with a running child',
    facts: { marker: 'unused', child: 'running' },
    expected: 'cancel',
  },
  {
    name: 'an unused ticket with a gone child',
    facts: { marker: 'unused', child: 'gone' },
    expected: 'cancel',
  },
  {
    name: 'an unused ticket with an unknown child',
    facts: { marker: 'unused', child: 'unknown' },
    expected: 'cancel',
  },
  {
    name: 'a started ticket whose process is gone',
    facts: { marker: 'started', child: 'gone' },
    expected: 'deleteMarker',
  },
  {
    name: 'a started ticket whose process runs',
    facts: { marker: 'started', child: 'running' },
    expected: 'refuseRunning',
  },
  {
    name: 'a started ticket whose process state is unknown',
    facts: { marker: 'started', child: 'unknown' },
    expected: 'refuseRunning',
  },
  {
    name: 'a marker name without a process id',
    facts: { marker: 'malformed', child: 'gone' },
    expected: 'refuseMalformed',
  },
])('decides to $expected for $name', ({ facts, expected }) => {
  expect(sweepAction(facts)).toBe(expected);
});
