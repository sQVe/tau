import { expect, it } from 'vitest';

import { claimReleaseDecision } from './claimReleaseDecision.js';
import type { ClaimReleaseAction, ClaimReleaseFacts } from './claimReleaseDecision.js';

const facts = (overrides: Partial<ClaimReleaseFacts>): ClaimReleaseFacts => ({
  ticket: 'taken',
  adopted: false,
  terminal: 'live',
  stopAttempted: false,
  ...overrides,
});

it.each<{ name: string; facts: ClaimReleaseFacts; expected: ClaimReleaseAction }>([
  {
    name: 'a launch that was not created',
    facts: facts({ ticket: 'notCreated', terminal: 'unknown' }),
    expected: 'release',
  },
  {
    name: 'a ticket the caller cancelled',
    facts: facts({ ticket: 'cancelled', terminal: 'unknown' }),
    expected: 'release',
  },
  {
    name: 'a taken ticket whose lookup found no terminal',
    facts: facts({ terminal: 'absent' }),
    expected: 'release',
  },
  {
    name: 'a taken ticket for a Pi that adopted the claim',
    facts: facts({ adopted: true, terminal: 'live' }),
    expected: 'release',
  },
  {
    name: 'a taken ticket with an ended terminal',
    facts: facts({ terminal: 'ended' }),
    expected: 'release',
  },
  {
    name: 'a taken ticket with a live terminal before a stop',
    facts: facts({ terminal: 'live', stopAttempted: false }),
    expected: 'stop',
  },
  {
    name: 'a taken ticket with a live terminal after a stop',
    facts: facts({ terminal: 'live', stopAttempted: true }),
    expected: 'keep',
  },
  {
    name: 'a taken ticket with an unknown terminal',
    facts: facts({ terminal: 'unknown' }),
    expected: 'keep',
  },
  {
    name: 'a ticket the caller could not cancel or read',
    facts: facts({ ticket: 'unread', terminal: 'live' }),
    expected: 'keep',
  },
])('decides to $expected for $name', ({ facts: releaseFacts, expected }) => {
  expect(claimReleaseDecision(releaseFacts)).toBe(expected);
});
