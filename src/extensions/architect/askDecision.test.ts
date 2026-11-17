import { expect, it } from 'vitest';

import { askOutcome } from './askDecision.js';

it.each([
  {
    name: 'a sent answer is answered',
    facts: { status: 'sent', ended: true, exitCode: 0 },
    expected: 'answered',
  },
  {
    name: 'a deadline is needsOpen',
    facts: { status: 'timeout', ended: false, exitCode: null },
    expected: 'needsOpen',
  },
  {
    name: 'a running ask that has not ended is needsOpen',
    facts: { status: 'running', ended: false, exitCode: null },
    expected: 'needsOpen',
  },
  {
    name: 'an ask that ended without sending is needsOpen',
    facts: { status: 'running', ended: true, exitCode: 0 },
    expected: 'needsOpen',
  },
  {
    name: 'a failed ask is failed',
    facts: { status: 'failed', ended: true, exitCode: 1 },
    expected: 'failed',
  },
  {
    name: 'an ask that ended on a failure is failed',
    facts: { status: 'running', ended: true, exitCode: 1 },
    expected: 'failed',
  },
] as const)('$name', ({ facts, expected }) => {
  expect(askOutcome(facts)).toBe(expected);
});
