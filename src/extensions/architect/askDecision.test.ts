import { expect, it } from 'vitest';

import { askOutcome, askRoute } from './askDecision.js';
import type { ArchitectOwner } from './record.js';

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

const owner = (overrides: Partial<ArchitectOwner> = {}): ArchitectOwner => ({
  lockToken: 'live',
  mode: 'visible',
  terminal: 't-architect',
  sessionId: 'session-architect',
  ...overrides,
});

it.each([
  {
    name: 'a foreign holder asks to open',
    facts: {
      root: '/repo',
      holder: { checkout: '/other', token: 'live' },
      owner: owner(),
      sessionFile: '/repo/architect.jsonl',
    },
    expected: {
      kind: 'needsOpen',
      reason: 'The architect is already running in /other. Call architect open to talk to it.',
    },
  },
  {
    name: 'an ownerless holder is starting',
    facts: {
      root: '/repo',
      holder: { checkout: '/repo', token: 'live' },
      owner: null,
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' },
  },
  {
    name: 'a token mismatch is starting',
    facts: {
      root: '/repo',
      holder: { checkout: '/repo', token: 'live' },
      owner: owner({ lockToken: 'recorded' }),
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' },
  },
  {
    name: 'ask mode waits for the answer',
    facts: {
      root: '/repo',
      holder: { checkout: '/repo', token: 'live' },
      owner: owner({ mode: 'ask' }),
      sessionFile: '/repo/architect.jsonl',
    },
    expected: {
      kind: 'needsOpen',
      reason: 'A hidden ask is running. Wait for its answer.',
    },
  },
  {
    name: 'no hc terminal needs the pane',
    facts: {
      root: '/repo',
      holder: { checkout: '/repo', token: 'live' },
      owner: owner({ terminal: null }),
      sessionFile: '/repo/architect.jsonl',
    },
    expected: {
      kind: 'needsOpen',
      reason: 'The live architect runs outside an hc terminal. Switch to its pane to talk to it.',
    },
  },
  {
    name: 'a matching visible owner is live',
    facts: {
      root: '/repo',
      holder: { checkout: '/repo', token: 'live' },
      owner: owner(),
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'live', terminal: 't-architect', sessionId: 'session-architect' },
  },
  {
    name: 'a live owner needs no session file',
    facts: {
      root: '/repo',
      holder: { checkout: '/repo', token: 'live' },
      owner: owner(),
      sessionFile: null,
    },
    expected: { kind: 'live', terminal: 't-architect', sessionId: 'session-architect' },
  },
  {
    name: 'an ownerless holder needs no session file',
    facts: {
      root: '/repo',
      holder: { checkout: '/repo', token: 'live' },
      owner: null,
      sessionFile: null,
    },
    expected: { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' },
  },
  {
    name: 'no holder and no session asks to open',
    facts: { root: '/repo', holder: undefined, owner: null, sessionFile: null },
    expected: {
      kind: 'needsOpen',
      reason: 'No architect session is recorded for this checkout. Call architect open first.',
    },
  },
  {
    name: 'no holder asks hidden',
    facts: {
      root: '/repo',
      holder: undefined,
      owner: null,
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'hidden', sessionFile: '/repo/architect.jsonl' },
  },
  {
    name: 'a stale owner without a holder asks hidden',
    facts: {
      root: '/repo',
      holder: undefined,
      owner: owner(),
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'hidden', sessionFile: '/repo/architect.jsonl' },
  },
])('$name', ({ facts, expected }) => {
  expect(askRoute(facts)).toMatchObject(expected);
});
