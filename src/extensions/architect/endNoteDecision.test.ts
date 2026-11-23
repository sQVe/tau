import { expect, it } from 'vitest';

import { decideEndNote, nextFinalHandoverState } from './endNoteDecision.js';
import type { ArchitectRecordFact, EndNoteFacts } from './endNoteDecision.js';

interface ExpectedDecision {
  kind: 'none' | 'send';
  target: string;
  includes: readonly string[];
}

const read: ArchitectRecordFact = {
  kind: 'read',
  sessionFile: '/sessions/architect.jsonl',
  updatedAt: '2026-11-23T08:00:00.000Z',
};

const facts = (overrides: Partial<EndNoteFacts> = {}): EndNoteFacts => ({
  mode: 'visible',
  leadTerminal: 't-lead',
  architectTerminal: 't-architect',
  finalHandover: 'none',
  record: read,
  ...overrides,
});

const expected = (kind: 'none' | 'send', includes: readonly string[] = []): ExpectedDecision => ({
  kind,
  target: kind === 'send' ? 't-lead' : '',
  includes,
});

it.each([
  {
    name: 'a visible architect with no final handover sends its terminal and record',
    facts: facts(),
    expected: expected('send', [
      't-architect',
      '/sessions/architect.jsonl',
      read.updatedAt,
      'without a final handover',
    ]),
  },
  {
    name: 'a visible architect with an unknown final handover says the send may not have arrived',
    facts: facts({ finalHandover: 'unknown' }),
    expected: expected('send', ['t-architect', 'returned unknown', read.updatedAt]),
  },
  {
    name: 'a visible architect with a queued final handover sends nothing',
    facts: facts({ finalHandover: 'queued' }),
    expected: expected('none'),
  },
  {
    name: 'ask mode sends nothing',
    facts: facts({ mode: 'ask' }),
    expected: expected('none'),
  },
  {
    name: 'a null lead terminal sends nothing',
    facts: facts({ leadTerminal: null }),
    expected: expected('none'),
  },
  {
    name: 'an empty lead terminal sends nothing',
    facts: facts({ leadTerminal: '' }),
    expected: expected('none'),
  },
  {
    name: 'a null architect terminal names it as unknown',
    facts: facts({ architectTerminal: null }),
    expected: expected('send', ['terminal unknown']),
  },
  {
    name: 'a missing record says it is missing',
    facts: facts({ record: { kind: 'missing' } }),
    expected: expected('send', ['Its record is missing.']),
  },
  {
    name: 'an unreadable record gives the reason',
    facts: facts({ record: { kind: 'unreadable', reason: 'the JSON is broken' } }),
    expected: expected('send', ['Its record could not be read: the JSON is broken.']),
  },
] as const)('$name', ({ facts: decisionFacts, expected: wanted }) => {
  const decision = decideEndNote(decisionFacts);

  expect(decision.kind).toBe(wanted.kind);

  const target = decision.kind === 'send' ? decision.target : '';
  const text = decision.kind === 'send' ? decision.text : '';
  const missing = wanted.includes.filter((value) => !`${target} ${text}`.includes(value));

  expect(missing).toEqual([]);
  expect(target).toBe(wanted.target);
});

it.each([
  {
    name: 'none stays none without a status',
    current: 'none',
    status: undefined,
    expected: 'none',
  },
  { name: 'none becomes unknown', current: 'none', status: 'unknown', expected: 'unknown' },
  { name: 'none becomes queued', current: 'none', status: 'queued', expected: 'queued' },
  {
    name: 'unknown stays unknown without a status',
    current: 'unknown',
    status: undefined,
    expected: 'unknown',
  },
  { name: 'unknown stays unknown', current: 'unknown', status: 'unknown', expected: 'unknown' },
  { name: 'unknown becomes queued', current: 'unknown', status: 'queued', expected: 'queued' },
  {
    name: 'queued stays queued without a status',
    current: 'queued',
    status: undefined,
    expected: 'queued',
  },
  {
    name: 'queued stays queued after unknown',
    current: 'queued',
    status: 'unknown',
    expected: 'queued',
  },
  {
    name: 'queued stays queued after queued',
    current: 'queued',
    status: 'queued',
    expected: 'queued',
  },
] as const)('$name', ({ current, status, expected: wanted }) => {
  expect(nextFinalHandoverState(current, status)).toBe(wanted);
});
