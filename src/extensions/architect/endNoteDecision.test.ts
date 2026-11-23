import { expect, it } from 'vitest';

import { decideEndNote, nextEndNoteRoute } from './endNoteDecision.js';
import type { ArchitectRecordFact, EndNoteRoute } from './endNoteDecision.js';
import type { FinalHandoverResult } from './queuedHandover.js';

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

const cases: readonly {
  name: string;
  route: EndNoteRoute;
  record: ArchitectRecordFact;
  includes: readonly string[];
}[] = [
  {
    name: 'a visible architect with no final handover sends its terminal and record',
    route: route(),
    record: read,
    includes: [
      't-architect',
      '/sessions/architect.jsonl',
      readUpdatedAt,
      'without a final handover',
    ],
  },
  {
    name: 'a visible architect with an unknown final handover says the send may not have arrived',
    route: route({ finalHandover: 'unknown' }),
    record: read,
    includes: ['t-architect', 'returned unknown', readUpdatedAt],
  },
  {
    name: 'a null architect terminal names it as unknown',
    route: route({ architectTerminal: null }),
    record: read,
    includes: ['terminal unknown'],
  },
  {
    name: 'a readable record with a null session file names none',
    route: route(),
    record: { kind: 'read', sessionFile: null, updatedAt: readUpdatedAt },
    includes: ['session file none', readUpdatedAt],
  },
  {
    name: 'a missing record says it is missing',
    route: route(),
    record: { kind: 'missing' },
    includes: ['Its record is missing.'],
  },
  {
    name: 'an unreadable record gives the reason',
    route: route(),
    record: { kind: 'unreadable', reason: 'the JSON is broken' },
    includes: ['Its record could not be read: the JSON is broken.'],
  },
];

it.each(cases)('$name', ({ route: current, record, includes }) => {
  const note = decideEndNote(current, record);
  const missing = includes.filter((value) => !`${note.target} ${note.text}`.includes(value));

  expect(note.target).toBe('t-lead');
  expect(missing).toEqual([]);
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
    name: 'a suppressed route stays absent after a later unknown result',
    current: nextEndNoteRoute(route(), result('queued')),
    result: result('unknown'),
    expected: undefined,
  },
] as const)('$name', ({ current, result: handover, expected: wanted }) => {
  expect(nextEndNoteRoute(current, handover)).toEqual(wanted);
});
