import { expect, it } from 'vitest';

import { sweepAction } from './startTicketDecision.js';
import type { SweepAction, SweepFacts } from './startTicketDecision.js';

it.each<{ name: string; facts: SweepFacts; expected: SweepAction }>([
  {
    name: 'a marker name without a process id',
    facts: { kind: 'malformed', path: '/start/token.started' },
    expected: { kind: 'refuseMalformed', path: '/start/token.started' },
  },
  {
    name: 'a marker name with an unrecognised suffix',
    facts: { kind: 'malformed', path: '/start/token.started-other' },
    expected: { kind: 'refuseMalformed', path: '/start/token.started-other' },
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
  {
    name: 'adopted, child gone, lead gone',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'gone',
      lead: 'gone',
    },
    expected: { kind: 'deleteMarker', path: '/start/token.adopted.1' },
  },
  {
    name: 'adopted, child gone, lead runs',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'gone',
      lead: 'running',
    },
    expected: { kind: 'leave' },
  },
  {
    name: 'adopted, child gone, lead unknown',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'gone',
      lead: 'unknown',
    },
    expected: { kind: 'leave' },
  },
  {
    name: 'adopted, child runs, lead gone',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'running',
      lead: 'gone',
    },
    expected: { kind: 'refuseRunning', processId: 1 },
  },
  {
    name: 'adopted, child runs, lead runs',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'running',
      lead: 'running',
    },
    expected: { kind: 'refuseRunning', processId: 1 },
  },
  {
    name: 'adopted, child runs, lead unknown',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'running',
      lead: 'unknown',
    },
    expected: { kind: 'refuseRunning', processId: 1 },
  },
  {
    name: 'adopted, child unknown, lead gone',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'unknown',
      lead: 'gone',
    },
    expected: { kind: 'refuseRunning', processId: 1 },
  },
  {
    name: 'adopted, child unknown, lead runs',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'unknown',
      lead: 'running',
    },
    expected: { kind: 'refuseRunning', processId: 1 },
  },
  {
    name: 'adopted, child unknown, lead unknown',
    facts: {
      kind: 'adopted',
      path: '/start/token.adopted.1',
      processId: 1,
      child: 'unknown',
      lead: 'unknown',
    },
    expected: { kind: 'refuseRunning', processId: 1 },
  },
])('decides to $expected.kind for $name', ({ facts, expected }) => {
  expect(sweepAction(facts)).toEqual(expected);
});
