import { expect, it } from 'vitest';

import { sweepAction } from './startTicketDecision.js';
import type { SweepAction, SweepFacts } from './startTicketDecision.js';

it.each<{ name: string; facts: SweepFacts; expected: SweepAction }>([
  {
    name: 'an unused ticket with a live terminal',
    facts: { marker: 'unused', terminal: 'live' },
    expected: 'cancel',
  },
  {
    name: 'an unused ticket with an ended terminal',
    facts: { marker: 'unused', terminal: 'ended' },
    expected: 'cancel',
  },
  {
    name: 'an unused ticket with an unread terminal',
    facts: { marker: 'unused', terminal: 'unread' },
    expected: 'cancel',
  },
  {
    name: 'an unused ticket with no terminal',
    facts: { marker: 'unused', terminal: 'none' },
    expected: 'cancel',
  },
  {
    name: 'a started ticket with a live terminal',
    facts: { marker: 'started', terminal: 'live' },
    expected: 'refuse',
  },
  {
    name: 'a started ticket with an ended terminal',
    facts: { marker: 'started', terminal: 'ended' },
    expected: 'deleteMarker',
  },
  {
    name: 'a started ticket with an unread terminal',
    facts: { marker: 'started', terminal: 'unread' },
    expected: 'refuse',
  },
  {
    name: 'a started ticket with no terminal',
    facts: { marker: 'started', terminal: 'none' },
    expected: 'refuse',
  },
])('decides to $expected for $name', ({ facts, expected }) => {
  expect(sweepAction(facts)).toBe(expected);
});
