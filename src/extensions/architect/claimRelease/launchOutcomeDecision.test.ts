import { expect, it } from 'vitest';

import { launchOutcomeDecision } from './launchOutcomeDecision.js';
import type { LaunchOutcome, LaunchOutcomeFacts } from './launchOutcomeDecision.js';

const facts = (overrides: Partial<LaunchOutcomeFacts>): LaunchOutcomeFacts => ({
  exitCode: 0,
  killed: false,
  aborted: false,
  replyTerminal: 'valid',
  ...overrides,
});

it.each<{ name: string; facts: LaunchOutcomeFacts; expected: LaunchOutcome }>([
  {
    name: 'a valid-looking reply with a nonzero exit',
    facts: facts({ exitCode: 1 }),
    expected: 'notCreated',
  },
  {
    name: 'a valid-looking reply from a killed client',
    facts: facts({ killed: true }),
    expected: 'notCreated',
  },
  {
    name: 'a killed launch client',
    facts: facts({ killed: true, replyTerminal: 'missing' }),
    expected: 'notCreated',
  },
  {
    name: 'an aborted launch client',
    facts: facts({ aborted: true, replyTerminal: 'missing' }),
    expected: 'notCreated',
  },
  {
    name: 'a reply that is not JSON',
    facts: facts({ replyTerminal: 'malformed' }),
    expected: 'notCreated',
  },
  {
    name: 'a reply without a terminal',
    facts: facts({ replyTerminal: 'missing' }),
    expected: 'notCreated',
  },
  {
    name: 'an exit zero with a valid terminal address',
    facts: facts({ replyTerminal: 'valid' }),
    expected: 'created',
  },
])('decides $expected for $name', ({ facts: launchFacts, expected }) => {
  expect(launchOutcomeDecision(launchFacts)).toBe(expected);
});
