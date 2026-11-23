import { expect, it } from 'vitest';

import { decideEndNote, nextEndNoteRoute, selectEndNote } from './endNoteDecision.js';
import type { ArchitectRecordFact, EndNoteRoute } from './endNoteDecision.js';
import type { FinalHandoverResult } from './queuedHandover.js';

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
    name: 'a readable record with a null session file names none',
    selection: route(),
    record: { kind: 'read', sessionFile: null, updatedAt: readUpdatedAt },
    expected: expected('send', ['session file none', readUpdatedAt]),
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

const result = (
  status: FinalHandoverResult['status'],
  terminal: string | undefined = 't-lead',
): FinalHandoverResult => ({ status, terminal });

it.each([
  {
    name: 'no route stays absent without a result for it',
    current: undefined,
    result: result('unknown'),
    expected: undefined,
  },
  {
    name: 'none becomes unknown after an unknown result for the lead',
    current: route(),
    result: result('unknown'),
    expected: route({ finalHandover: 'unknown' }),
  },
  {
    name: 'none becomes absent after a queued result for the lead',
    current: route(),
    result: result('queued'),
    expected: undefined,
  },
  {
    name: 'none is unchanged by a queued result for another terminal',
    current: route(),
    result: result('queued', 't-other'),
    expected: route(),
  },
  {
    name: 'none is unchanged by an unknown result for another terminal',
    current: route(),
    result: result('unknown', 't-other'),
    expected: route(),
  },
  {
    name: 'none is unchanged by a result without a terminal',
    current: route(),
    result: { status: 'queued', terminal: undefined },
    expected: route(),
  },
  {
    name: 'unknown stays unknown after an unknown result for the lead',
    current: route({ finalHandover: 'unknown' }),
    result: result('unknown'),
    expected: route({ finalHandover: 'unknown' }),
  },
  {
    name: 'unknown becomes absent after a queued result for the lead',
    current: route({ finalHandover: 'unknown' }),
    result: result('queued'),
    expected: undefined,
  },
  {
    name: 'unknown is unchanged by a queued result for another terminal',
    current: route({ finalHandover: 'unknown' }),
    result: result('queued', 't-other'),
    expected: route({ finalHandover: 'unknown' }),
  },
  {
    name: 'queued stays absent after an unknown result for the lead',
    current: route({ finalHandover: 'queued' }),
    result: result('unknown'),
    expected: undefined,
  },
  {
    name: 'queued stays absent after a queued result for the lead',
    current: route({ finalHandover: 'queued' }),
    result: result('queued'),
    expected: undefined,
  },
  {
    name: 'queued stays queued after a result for another terminal',
    current: route({ finalHandover: 'queued' }),
    result: result('queued', 't-other'),
    expected: route({ finalHandover: 'queued' }),
  },
] as const)('$name', ({ current, result: handover, expected: wanted }) => {
  expect(nextEndNoteRoute(current, handover)).toEqual(wanted);
});
