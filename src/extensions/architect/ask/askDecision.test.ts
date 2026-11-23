import { expect, it } from 'vitest';

import type { ArchitectOwner } from '../record.js';
import {
  askDeadlineAction,
  askRecordOutcome,
  askRoute,
  askTransition,
  staleAskRepair,
} from './askDecision.js';
import type { AskRouteFacts } from './askDecision.js';

it.each([
  {
    name: 'a sent answer is answered',
    facts: { status: 'sent', answer: 'Use --quick.' },
    expected: 'answered',
  },
  {
    name: 'a sent record without an answer is kept',
    facts: { status: 'sent', answer: null },
    expected: 'kept',
  },
  {
    name: 'a deadline is a deadline outcome',
    facts: { status: 'timeout', answer: null },
    expected: 'deadline',
  },
  {
    name: 'a failed ask is failed',
    facts: { status: 'failed', answer: null },
    expected: 'failed',
  },
  {
    name: 'a running ask is kept',
    facts: { status: 'running', answer: null },
    expected: 'kept',
  },
] as const)('$name', ({ facts, expected }) => {
  expect(askRecordOutcome(facts)).toBe(expected);
});

const owner = (overrides: Partial<ArchitectOwner> = {}): ArchitectOwner => ({
  lockToken: 'live',
  mode: 'visible',
  terminal: 't-architect',
  sessionId: 'session-architect',
  ...overrides,
});

const holderStart = Date.parse('2026-11-18T10:00:00.000Z');
const startingReason = 'The architect is starting. Ask again shortly.';

const versionReason =
  'The architect in this checkout runs an older Tau version without live asks. Wait until it closes, then call architect ask again. If it runs in a pane, the user can talk to it there.';

const held = (checkout: string): { checkout: string; token: string; startedAt: number } => ({
  checkout,
  token: 'live',
  startedAt: holderStart,
});

it.each<{ name: string; facts: AskRouteFacts; expected: Record<string, unknown> }>([
  {
    name: 'a foreign holder asks to open',
    facts: {
      root: '/repo',
      holder: held('/other'),
      publication: { kind: 'owner', owner: owner() },
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
      holder: held('/repo'),
      publication: { kind: 'none' },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' },
  },
  {
    name: 'a token mismatch is starting',
    facts: {
      root: '/repo',
      holder: held('/repo'),
      publication: { kind: 'owner', owner: owner({ lockToken: 'recorded' }) },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' },
  },
  {
    name: 'ask mode waits for the answer',
    facts: {
      root: '/repo',
      holder: held('/repo'),
      publication: { kind: 'owner', owner: owner({ mode: 'ask' }) },
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
      holder: held('/repo'),
      publication: { kind: 'owner', owner: owner({ terminal: null }) },
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
      holder: held('/repo'),
      publication: { kind: 'owner', owner: owner() },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: {
      kind: 'live',
      terminal: 't-architect',
      sessionId: 'session-architect',
      lockToken: 'live',
    },
  },
  {
    name: 'a live owner needs no session file',
    facts: {
      root: '/repo',
      holder: held('/repo'),
      publication: { kind: 'owner', owner: owner() },
      sessionFile: null,
    },
    expected: {
      kind: 'live',
      terminal: 't-architect',
      sessionId: 'session-architect',
      lockToken: 'live',
    },
  },
  {
    name: 'an ownerless holder needs no session file',
    facts: {
      root: '/repo',
      holder: held('/repo'),
      publication: { kind: 'none' },
      sessionFile: null,
    },
    expected: { kind: 'needsOpen', reason: 'The architect is starting. Ask again shortly.' },
  },
  {
    name: 'no holder and no session asks to open',
    facts: { root: '/repo', holder: undefined, publication: { kind: 'none' }, sessionFile: null },
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
      publication: { kind: 'none' },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'hidden', sessionFile: '/repo/architect.jsonl' },
  },
  {
    name: 'a stale owner without a holder asks hidden',
    facts: {
      root: '/repo',
      holder: undefined,
      publication: { kind: 'owner', owner: owner() },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'hidden', sessionFile: '/repo/architect.jsonl' },
  },
  {
    name: 'a version 1 record written at the holder start reports the version',
    facts: {
      root: '/repo',
      holder: held('/repo'),
      publication: { kind: 'version1', updatedAt: holderStart },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen', reason: versionReason },
  },
  {
    name: 'a version 1 record written after the holder start reports the version',
    facts: {
      root: '/repo',
      holder: held('/repo'),
      publication: { kind: 'version1', updatedAt: holderStart + 1 },
      sessionFile: null,
    },
    expected: { kind: 'needsOpen', reason: versionReason },
  },
  {
    name: 'a version 1 record written before the holder start is starting',
    facts: {
      root: '/repo',
      holder: held('/repo'),
      publication: { kind: 'version1', updatedAt: holderStart - 1 },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen', reason: startingReason },
  },
  {
    name: 'a version 1 record with an unparsable time is starting',
    facts: {
      root: '/repo',
      holder: held('/repo'),
      publication: { kind: 'version1', updatedAt: Number.NaN },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen', reason: startingReason },
  },
  {
    name: 'a holder with an unparsable start is starting for a version 1 record',
    facts: {
      root: '/repo',
      holder: { checkout: '/repo', token: 'live', startedAt: Number.NaN },
      publication: { kind: 'version1', updatedAt: holderStart },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'needsOpen', reason: startingReason },
  },
  {
    name: 'a version 1 record without a holder asks hidden',
    facts: {
      root: '/repo',
      holder: undefined,
      publication: { kind: 'version1', updatedAt: holderStart },
      sessionFile: '/repo/architect.jsonl',
    },
    expected: { kind: 'hidden', sessionFile: '/repo/architect.jsonl' },
  },
])('$name', ({ facts, expected }) => {
  expect(askRoute(facts)).toMatchObject(expected);
});

it.each([
  {
    name: 'a running ask before its deadline waits',
    facts: { status: 'running', now: 1000, deadline: 2000 },
    expected: 'wait',
  },
  {
    name: 'a running ask at its deadline expires',
    facts: { status: 'running', now: 2000, deadline: 2000 },
    expected: 'expire',
  },
  {
    name: 'a running ask after its deadline expires',
    facts: { status: 'running', now: 3000, deadline: 2000 },
    expected: 'expire',
  },
  {
    name: 'a sent ask at its deadline waits',
    facts: { status: 'sent', now: 3000, deadline: 2000 },
    expected: 'wait',
  },
  {
    name: 'a timeout ask at its deadline waits',
    facts: { status: 'timeout', now: 3000, deadline: 2000 },
    expected: 'wait',
  },
] as const)('ask deadline: $name', ({ facts, expected }) => {
  expect(askDeadlineAction(facts)).toBe(expected);
});

it.each([
  {
    name: 'a running ask whose recorded terminal ended repairs',
    facts: {
      status: 'running',
      terminalState: 'ended',
      recordTerminal: 't-ask',
      endedTerminal: 't-ask',
    },
    expected: 'repair',
  },
  {
    name: 'a running ask whose terminal is live leaves it',
    facts: {
      status: 'running',
      terminalState: 'live',
      recordTerminal: 't-ask',
      endedTerminal: 't-ask',
    },
    expected: 'leave',
  },
  {
    name: 'a running ask whose recorded terminal changed leaves it',
    facts: {
      status: 'running',
      terminalState: 'ended',
      recordTerminal: 't-old',
      endedTerminal: 't-new',
    },
    expected: 'leave',
  },
  {
    name: 'a running ask without a recorded terminal leaves it',
    facts: {
      status: 'running',
      terminalState: 'ended',
      recordTerminal: null,
      endedTerminal: 't-ask',
    },
    expected: 'leave',
  },
  {
    name: 'a sent ask whose terminal ended leaves it',
    facts: {
      status: 'sent',
      terminalState: 'ended',
      recordTerminal: 't-ask',
      endedTerminal: 't-ask',
    },
    expected: 'leave',
  },
] as const)('stale ask repair: $name', ({ facts, expected }) => {
  expect(staleAskRepair(facts)).toBe(expected);
});

it.each([
  { name: 'running to sent', facts: { current: 'running', next: 'sent' }, expected: 'allowed' },
  {
    name: 'running to timeout',
    facts: { current: 'running', next: 'timeout' },
    expected: 'allowed',
  },
  { name: 'running to failed', facts: { current: 'running', next: 'failed' }, expected: 'allowed' },
  {
    name: 'running to running',
    facts: { current: 'running', next: 'running' },
    expected: 'allowed',
  },
  { name: 'sent to timeout', facts: { current: 'sent', next: 'timeout' }, expected: 'refused' },
  { name: 'sent to failed', facts: { current: 'sent', next: 'failed' }, expected: 'refused' },
  { name: 'sent to sent', facts: { current: 'sent', next: 'sent' }, expected: 'refused' },
  { name: 'timeout to sent', facts: { current: 'timeout', next: 'sent' }, expected: 'refused' },
  { name: 'timeout to failed', facts: { current: 'timeout', next: 'failed' }, expected: 'refused' },
  { name: 'failed to sent', facts: { current: 'failed', next: 'sent' }, expected: 'refused' },
  { name: 'failed to running', facts: { current: 'failed', next: 'running' }, expected: 'refused' },
] as const)('ask transition: $name', ({ facts, expected }) => {
  expect(askTransition(facts)).toBe(expected);
});
