import { expect, it } from 'vitest';

import { claimReleaseDecision } from './claimReleaseDecision.js';
import type { ClaimReleaseAction, ClaimReleaseFacts } from './claimReleaseDecision.js';

const facts = (overrides: Partial<ClaimReleaseFacts>): ClaimReleaseFacts => ({
  launch: 'started',
  adopted: false,
  terminal: 'live',
  stopAttempted: false,
  ...overrides,
});

it.each<{ name: string; facts: ClaimReleaseFacts; expected: ClaimReleaseAction }>([
  {
    name: 'a launch that did not run',
    facts: facts({ launch: 'notRun', terminal: 'unknown' }),
    expected: 'release',
  },
  {
    name: 'a launch that failed',
    facts: facts({ launch: 'failed', terminal: 'unknown' }),
    expected: 'release',
  },
  {
    name: 'a started Pi that adopted the claim',
    facts: facts({ adopted: true, terminal: 'live' }),
    expected: 'release',
  },
  {
    name: 'a started Pi with an ended terminal',
    facts: facts({ terminal: 'ended' }),
    expected: 'release',
  },
  {
    name: 'a started Pi with a live terminal before a stop',
    facts: facts({ terminal: 'live', stopAttempted: false }),
    expected: 'stop',
  },
  {
    name: 'a started Pi with a live terminal after a stop',
    facts: facts({ terminal: 'live', stopAttempted: true }),
    expected: 'keep',
  },
  {
    name: 'a started Pi with an unknown terminal',
    facts: facts({ terminal: 'unknown' }),
    expected: 'keep',
  },
])('decides to $expected for $name', ({ facts: releaseFacts, expected }) => {
  expect(claimReleaseDecision(releaseFacts)).toBe(expected);
});
