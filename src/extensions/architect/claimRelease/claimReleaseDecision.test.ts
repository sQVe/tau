import { expect, it } from 'vitest';

import { claimReleaseDecision } from './claimReleaseDecision.js';
import type { ClaimReleaseAction, ClaimReleaseFacts } from './claimReleaseDecision.js';

const facts = (overrides: Partial<ClaimReleaseFacts>): ClaimReleaseFacts => ({
  ticket: 'taken',
  adopted: false,
  child: 'running',
  stopAttempted: false,
  ...overrides,
});

it.each<{ name: string; facts: ClaimReleaseFacts; expected: ClaimReleaseAction }>([
  {
    name: 'a launch that was not created',
    facts: facts({ ticket: 'notCreated', child: 'unknown' }),
    expected: 'release',
  },
  {
    name: 'a ticket the caller cancelled',
    facts: facts({ ticket: 'cancelled', child: 'unknown' }),
    expected: 'release',
  },
  {
    name: 'a taken ticket whose child is gone',
    facts: facts({ child: 'gone' }),
    expected: 'release',
  },
  {
    name: 'a taken ticket for a Pi that adopted the claim',
    facts: facts({ adopted: true, child: 'running' }),
    expected: 'release',
  },
  {
    name: 'a taken ticket with a running child before a stop',
    facts: facts({ child: 'running', stopAttempted: false }),
    expected: 'stop',
  },
  {
    name: 'a taken ticket with a running child after a stop',
    facts: facts({ child: 'running', stopAttempted: true }),
    expected: 'keep',
  },
  {
    name: 'a taken ticket with an unknown child',
    facts: facts({ child: 'unknown' }),
    expected: 'keep',
  },
  {
    name: 'a ticket the caller could not cancel or read',
    facts: facts({ ticket: 'unread', child: 'running' }),
    expected: 'keep',
  },
])('decides to $expected for $name', ({ facts: releaseFacts, expected }) => {
  expect(claimReleaseDecision(releaseFacts)).toBe(expected);
});
