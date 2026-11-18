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
    facts: {
      root: '/repo',
      holderCheckout: undefined,
      architectTerminal: 't-arch',
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'hidden', sessionFile: '/repo/architect.jsonl' },
  },
  {
    name: 'a live architect in this checkout gets the question in its inbox',
    facts: {
      root: '/repo',
      holderCheckout: '/repo',
      architectTerminal: 't-arch',
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'live', terminal: 't-arch' },
  },
  {
    name: 'a live architect needs no recorded session file',
    facts: {
      root: '/repo',
      holderCheckout: '/repo',
      architectTerminal: 't-arch',
      sessionFile: null,
    },
    expected: { kind: 'live', terminal: 't-arch' },
  },
  {
    name: 'a live architect that is still starting says to ask again shortly',
    facts: { root: '/repo', holderCheckout: '/repo', architectTerminal: null, sessionFile: null },
    expected: { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' },
    reasonExcludes: 'architect open',
  },
  {
    name: 'a hidden ask needs a recorded session file',
    facts: { root: '/repo', holderCheckout: undefined, architectTerminal: null, sessionFile: null },
    expected: {
      kind: 'needsOpen',
      reason: 'No architect session is recorded for this checkout. Call architect open first.',
    },
  },
  {
    name: 'a holder in another checkout is needsOpen',
    facts: {
      root: '/repo',
      holderCheckout: '/other',
      architectTerminal: 't-arch',
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen' },
  },
] as const)('$name', ({ facts, expected, ...rest }) => {
  const result = askRoute(facts);
  const reason = 'reason' in result ? result.reason : '';
  const excluded = 'reasonExcludes' in rest ? rest.reasonExcludes : undefined;
  const mentionsExcluded = excluded !== undefined && reason.includes(excluded);

  expect(result).toMatchObject(expected);
  expect(mentionsExcluded).toBe(false);
});
