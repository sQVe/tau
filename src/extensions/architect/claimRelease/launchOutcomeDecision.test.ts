import { expect, it } from 'vitest';

import { launchOutcomeDecision } from './launchOutcomeDecision.js';
import type { LaunchOutcome, LaunchOutcomeFacts } from './launchOutcomeDecision.js';

const facts = (overrides: Partial<LaunchOutcomeFacts>): LaunchOutcomeFacts => ({
  ran: true,
  exitCode: 0,
  killed: false,
  aborted: false,
  timedOut: false,
  replyTerminal: 'valid',
  ...overrides,
});

it.each<{ name: string; facts: LaunchOutcomeFacts; expected: LaunchOutcome }>([
  {
    name: 'a spawn error that never ran the command',
    facts: facts({ ran: false, exitCode: null, replyTerminal: 'missing' }),
    expected: 'refused',
  },
  {
    name: 'a nonzero exit',
    facts: facts({ exitCode: 1, replyTerminal: 'missing' }),
    expected: 'unknown',
  },
  {
    name: 'a killed launch client',
    facts: facts({ killed: true, replyTerminal: 'missing' }),
    expected: 'unknown',
  },
  {
    name: 'an aborted launch client',
    facts: facts({ aborted: true, replyTerminal: 'missing' }),
    expected: 'unknown',
  },
  {
    name: 'a timed-out launch client',
    facts: facts({ timedOut: true, replyTerminal: 'missing' }),
    expected: 'unknown',
  },
  {
    name: 'a reply that is not JSON',
    facts: facts({ replyTerminal: 'malformed' }),
    expected: 'unknown',
  },
  {
    name: 'a reply that fails its schema',
    facts: facts({ replyTerminal: 'malformed' }),
    expected: 'unknown',
  },
  {
    name: 'a reply without a terminal',
    facts: facts({ replyTerminal: 'missing' }),
    expected: 'unknown',
  },
  {
    name: 'a reply with an empty terminal',
    facts: facts({ replyTerminal: 'malformed' }),
    expected: 'unknown',
  },
  {
    name: 'an exit zero with a valid terminal address',
    facts: facts({ replyTerminal: 'valid' }),
    expected: 'created',
  },
])('decides $expected for $name', ({ facts: launchFacts, expected }) => {
  expect(launchOutcomeDecision(launchFacts)).toBe(expected);
});
