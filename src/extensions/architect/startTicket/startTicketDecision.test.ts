import { expect, it } from 'vitest';

import { sweepAction } from './startTicketDecision.js';
import type { SweepAction, SweepFacts } from './startTicketDecision.js';

it.each<{ name: string; facts: SweepFacts; expected: SweepAction }>([
  {
    name: 'an unused ticket',
    facts: { kind: 'unused' },
    expected: { kind: 'cancel' },
  },
  {
    name: 'a marker name without a process id',
    facts: { kind: 'malformed', path: '/start/token.started' },
    expected: { kind: 'refuseMalformed', path: '/start/token.started' },
  },
  {
    name: 'a started ticket whose process is gone',
    facts: { kind: 'started', path: '/start/token.started.1', processId: 1, child: 'gone' },
    expected: { kind: 'deleteMarker', path: '/start/token.started.1' },
  },
  {
    name: 'a started ticket whose process runs',
    facts: { kind: 'started', path: '/start/token.started.1', processId: 1, child: 'running' },
    expected: { kind: 'refuseRunning', processId: 1 },
  },
  {
    name: 'a started ticket whose process state is unknown',
    facts: { kind: 'started', path: '/start/token.started.1', processId: 1, child: 'unknown' },
    expected: { kind: 'refuseRunning', processId: 1 },
  },
])('decides to $expected.kind for $name', ({ facts, expected }) => {
  expect(sweepAction(facts)).toEqual(expected);
});
