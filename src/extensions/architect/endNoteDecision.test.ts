import { expect, it } from 'vitest';

import { decideEndNote, nextEndNoteRoute, selectEndNote } from './endNoteDecision.js';
import type { ArchitectRecordFact, EndNoteRoute } from './endNoteDecision.js';

interface ExpectedDecision {
  kind: 'none' | 'send';
  includes: readonly string[];
}

const readUpdatedAt = '2026-11-23T08:00:00.000Z';

const read: ArchitectRecordFact = {
  kind: 'read',
  sessionFile: '/sessions/architect.jsonl',
  updatedAt: readUpdatedAt,
};

const route = (overrides: Partial<EndNoteRoute> = {}): EndNoteRoute => ({
  leadTerminal: 't-lead',
  architectTerminal: 't-architect',
  finalHandover: 'none',
  ...overrides,
});

it.each([
  {
    name: 'no route sends nothing',
    value: undefined,
    expected: 'none',
  },
  {
    name: 'a queued final handover sends nothing',
    value: route({ finalHandover: 'queued' }),
    expected: 'none',
  },
  {
    name: 'a route without a final handover sends to its lead',
    value: route(),
    expected: 'send',
  },
  {
    name: 'an unknown final handover still sends',
    value: route({ finalHandover: 'unknown' }),
    expected: 'send',
  },
] as const)('selectEndNote for $name', ({ value, expected }) => {
  const selection = selectEndNote(value);
  const target = selection.kind === 'send' ? selection.target : undefined;
  const wantedTarget = expected === 'send' ? 't-lead' : undefined;

  expect(selection.kind).toBe(expected);
  expect(target).toBe(wantedTarget);
});

const expected = (kind: 'none' | 'send', includes: readonly string[] = []): ExpectedDecision => ({
  kind,
  includes,
});

const cases: readonly {
  name: string;
  selection: EndNoteRoute;
  record: ArchitectRecordFact;
  expected: ExpectedDecision;
}[] = [
  {
    name: 'a visible architect with no final handover sends its terminal and record',
    selection: route(),
    record: read,
    expected: expected('send', [
      't-architect',
      '/sessions/architect.jsonl',
      readUpdatedAt,
      'without a final handover',
    ]),
  },
  {
    name: 'a visible architect with an unknown final handover says the send may not have arrived',
    selection: route({ finalHandover: 'unknown' }),
    record: read,
    expected: expected('send', ['t-architect', 'returned unknown', readUpdatedAt]),
  },
  {
    name: 'a null architect terminal names it as unknown',
    selection: route({ architectTerminal: null }),
    record: read,
    expected: expected('send', ['terminal unknown']),
  },
  {
    name: 'a missing record says it is missing',
    selection: route(),
    record: { kind: 'missing' },
    expected: expected('send', ['Its record is missing.']),
  },
  {
    name: 'an unreadable record gives the reason',
    selection: route(),
    record: { kind: 'unreadable', reason: 'the JSON is broken' },
    expected: expected('send', ['Its record could not be read: the JSON is broken.']),
  },
];

it.each(cases)('$name', ({ selection: selected, record, expected: wanted }) => {
  const decision = decideEndNote(selectEndNote(selected), record);

  expect(decision.kind).toBe(wanted.kind);

  const target = decision.kind === 'send' ? decision.target : '';
  const text = decision.kind === 'send' ? decision.text : '';
  const missing = wanted.includes.filter((value) => !`${target} ${text}`.includes(value));
  const wantedTarget = wanted.kind === 'send' ? 't-lead' : '';

  expect(missing).toEqual([]);
  expect(target).toBe(wantedTarget);
});

it.each([
  {
    name: 'no route stays absent without a status',
    current: undefined,
    status: 'unknown',
    expected: undefined,
  },
  {
    name: 'none becomes unknown',
    current: route(),
    status: 'unknown',
    expected: 'unknown',
  },
  {
    name: 'none becomes absent after queued',
    current: route(),
    status: 'queued',
    expected: undefined,
  },
  {
    name: 'unknown stays unknown',
    current: route({ finalHandover: 'unknown' }),
    status: 'unknown',
    expected: 'unknown',
  },
  {
    name: 'unknown becomes absent after queued',
    current: route({ finalHandover: 'unknown' }),
    status: 'queued',
    expected: undefined,
  },
  {
    name: 'queued stays absent after unknown',
    current: route({ finalHandover: 'queued' }),
    status: 'unknown',
    expected: undefined,
  },
  {
    name: 'queued stays absent after queued',
    current: route({ finalHandover: 'queued' }),
    status: 'queued',
    expected: undefined,
  },
] as const)('$name', ({ current, status, expected: wanted }) => {
  const next = nextEndNoteRoute(current, status);

  expect(next?.finalHandover).toBe(wanted);
});
