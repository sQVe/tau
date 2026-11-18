import { expect, it } from 'vitest';

import { askOutcome, askRoute } from './askDecision.js';

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

it.each([
  {
    name: 'no live holder asks in a hidden terminal',
    facts: { root: '/repo', holderCheckout: undefined, architectTerminal: 't-arch' },
    expected: { kind: 'hidden' },
  },
  {
    name: 'a live architect in this checkout gets the question in its inbox',
    facts: { root: '/repo', holderCheckout: '/repo', architectTerminal: 't-arch' },
    expected: { kind: 'live', terminal: 't-arch' },
  },
  {
    name: 'a live architect without a recorded terminal is needsOpen',
    facts: { root: '/repo', holderCheckout: '/repo', architectTerminal: null },
    expected: { kind: 'needsOpen' },
  },
  {
    name: 'a holder in another checkout is needsOpen',
    facts: { root: '/repo', holderCheckout: '/other', architectTerminal: 't-arch' },
    expected: { kind: 'needsOpen' },
  },
] as const)('$name', ({ facts, expected }) => {
  expect(askRoute(facts)).toMatchObject(expected);
});
