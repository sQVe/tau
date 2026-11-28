import { expect, it } from 'vitest';

import type { ItemRead, ItemRecord, RunRead, RunRecord, Step, StepOutcome } from './records.js';
import { listRecordProblems, selectEvidence } from './selection.js';
import type { SelectedResult } from './selection.js';

const tree = 'tree-one';

const passedStep = (number: number): Step => ({ number, status: 'passed', artifacts: [] });

const differsStep = (number: number): Step => ({
  number,
  status: 'differs',
  observed: 'The dialog stays open.',
  artifacts: [],
});

const blockedStep = (number: number): Step => ({
  number,
  status: 'blocked',
  reason: 'The page did not load.',
  artifacts: [],
});

const notRunStep = (number: number): Step => ({
  number,
  status: 'notRun',
  reason: 'An earlier step blocked the run.',
  artifacts: [],
});

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  version: 1,
  run: 'run-a',
  target: '482',
  head: '1111111111111111111111111111111111111111',
  dirty: false,
  platform: { os: 'linux', arch: 'x64' },
  startedAt: '2026-11-16T10:00:00.000Z',
  treeAtLaunch: tree,
  treeAtStop: tree,
  launch: { exitCode: 0, logPath: 'launch.log' },
  doctor: { exitCode: 0, logPath: 'doctor.log' },
  stop: { exitCode: 0, logPath: 'stop.log' },
  items: [],
  ...overrides,
});

const itemRecord = (overrides: Partial<ItemRecord> = {}): ItemRecord => ({
  version: 1,
  run: 'run-a',
  item: 'journeys/check',
  drive: 'hand',
  steps: [passedStep(1)],
  endState: { status: 'passed' },
  ...overrides,
});

const validItem = (record: ItemRecord): ItemRead => ({
  item: record.item,
  path: `/verification/${record.run}/items/${record.item}.json`,
  read: { status: 'valid', record },
});

const runRead = (record: RunRecord, items: ItemRead[]): RunRead => ({
  run: record.run,
  directory: `/verification/${record.run}`,
  read: { status: 'valid', record },
  items,
});

const runWithItem = (record: RunRecord, item: ItemRecord): RunRead =>
  runRead(record, [validItem(item)]);

const summary = (result: SelectedResult) => ({
  target: result.target,
  item: result.item,
  run: result.run,
  freshness: result.freshness,
  outcome: result.outcome,
  counts: result.counts,
});

const fresh = { fresh: true } as const;

const passedCounts = { passed: 1, differs: 0, blocked: 0, notRun: 0 };

it.each([
  {
    name: 'a newer fresh failure over an older fresh pass',
    runs: [
      runWithItem(runRecord({ run: 'run-old' }), itemRecord({ run: 'run-old' })),
      runWithItem(
        runRecord({ run: 'run-new', startedAt: '2026-11-16T11:00:00.000Z' }),
        itemRecord({ run: 'run-new', steps: [differsStep(1)] }),
      ),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-new',
        freshness: fresh,
        outcome: 'failed',
        counts: { passed: 0, differs: 1, blocked: 0, notRun: 0 },
      },
    ],
  },
  {
    name: 'an older fresh item when a newer fresh run does not register it',
    runs: [
      runWithItem(runRecord({ run: 'run-old' }), itemRecord({ run: 'run-old' })),
      runRead(runRecord({ run: 'run-new', startedAt: '2026-11-16T11:00:00.000Z' }), []),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-old',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
    ],
  },
  {
    name: 'an older fresh item when the newer item file is missing',
    runs: [
      runWithItem(runRecord({ run: 'run-old' }), itemRecord({ run: 'run-old' })),
      runRead(runRecord({ run: 'run-new', startedAt: '2026-11-16T11:00:00.000Z' }), [
        {
          item: 'journeys/check',
          path: '/verification/run-new/items/journeys/check.json',
          read: { status: 'missing' },
        },
      ]),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-old',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
    ],
  },
  {
    name: 'an older fresh item when the newer item file is malformed',
    runs: [
      runWithItem(runRecord({ run: 'run-old' }), itemRecord({ run: 'run-old' })),
      runRead(runRecord({ run: 'run-new', startedAt: '2026-11-16T11:00:00.000Z' }), [
        {
          item: 'journeys/check',
          path: '/verification/run-new/items/journeys/check.json',
          read: { status: 'malformed' as const, problem: 'bad record' },
        },
      ]),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-old',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
    ],
  },
  {
    name: 'an older fresh pass over a newer stale result',
    runs: [
      runWithItem(runRecord({ run: 'run-old' }), itemRecord({ run: 'run-old' })),
      runWithItem(
        runRecord({
          run: 'run-new',
          startedAt: '2026-11-16T11:00:00.000Z',
          treeAtStop: 'tree-two',
        }),
        itemRecord({ run: 'run-new', steps: [differsStep(1)] }),
      ),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-old',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
    ],
  },
  {
    name: 'a stale result with its reason when nothing is fresh',
    runs: [
      runWithItem(
        runRecord({ run: 'run-old', treeAtStop: 'tree-two' }),
        itemRecord({ run: 'run-old' }),
      ),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-old',
        freshness: { fresh: false, reason: 'treeChangedDuringRun' },
        outcome: 'passed',
        counts: passedCounts,
      },
    ],
  },
  {
    name: 'nothing from an unstopped run',
    runs: [runWithItem(runRecord({ stop: null }), itemRecord())],
    expected: [],
  },
  {
    name: 'nothing from a run whose stop failed',
    runs: [runWithItem(runRecord({ stop: { exitCode: 7, logPath: 'stop.log' } }), itemRecord())],
    expected: [],
  },
  {
    name: 'nothing from a run whose stop was killed',
    runs: [runWithItem(runRecord({ stop: { exitCode: null, logPath: 'stop.log' } }), itemRecord())],
    expected: [],
  },
  {
    name: 'nothing from a malformed run',
    runs: [
      {
        run: 'run-a',
        directory: '/verification/run-a',
        read: { status: 'malformed' as const, problem: 'bad record' },
        items: [validItem(itemRecord())],
      },
    ],
    expected: [],
  },
  {
    name: 'two targets with the same item',
    runs: [
      runWithItem(runRecord({ run: 'run-a', target: '482' }), itemRecord({ run: 'run-a' })),
      runWithItem(runRecord({ run: 'run-b', target: '483' }), itemRecord({ run: 'run-b' })),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-a',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
      {
        target: '483',
        item: 'journeys/check',
        run: 'run-b',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
    ],
  },
  {
    name: 'the greater run name when startedAt is equal',
    runs: [
      runWithItem(runRecord({ run: 'run-a' }), itemRecord({ run: 'run-a' })),
      runWithItem(
        runRecord({ run: 'run-b' }),
        itemRecord({ run: 'run-b', steps: [differsStep(1)] }),
      ),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-b',
        freshness: fresh,
        outcome: 'failed',
        counts: { passed: 0, differs: 1, blocked: 0, notRun: 0 },
      },
    ],
  },
  {
    name: 'the newer run when it comes first in the input',
    runs: [
      runWithItem(
        runRecord({ run: 'run-new', startedAt: '2026-11-16T11:00:00.000Z' }),
        itemRecord({ run: 'run-new', steps: [differsStep(1)] }),
      ),
      runWithItem(runRecord({ run: 'run-old' }), itemRecord({ run: 'run-old' })),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-new',
        freshness: fresh,
        outcome: 'failed',
        counts: { passed: 0, differs: 1, blocked: 0, notRun: 0 },
      },
    ],
  },
  {
    name: 'the greater run name when it comes first in the input',
    runs: [
      runWithItem(
        runRecord({ run: 'run-b' }),
        itemRecord({ run: 'run-b', steps: [differsStep(1)] }),
      ),
      runWithItem(runRecord({ run: 'run-a' }), itemRecord({ run: 'run-a' })),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-b',
        freshness: fresh,
        outcome: 'failed',
        counts: { passed: 0, differs: 1, blocked: 0, notRun: 0 },
      },
    ],
  },
  {
    name: 'two ascending items under one target in their input order',
    runs: [
      runRead(runRecord({ run: 'run-a', target: '482' }), [
        validItem(itemRecord({ run: 'run-a', item: 'journeys/alpha' })),
        validItem(itemRecord({ run: 'run-a', item: 'journeys/zeta' })),
      ]),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/alpha',
        run: 'run-a',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
      {
        target: '482',
        item: 'journeys/zeta',
        run: 'run-a',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
    ],
  },
  {
    name: 'the newer stale result when nothing is fresh',
    runs: [
      runWithItem(
        runRecord({ run: 'run-old', treeAtStop: 'tree-two' }),
        itemRecord({ run: 'run-old' }),
      ),
      runWithItem(
        runRecord({
          run: 'run-new',
          startedAt: '2026-11-16T11:00:00.000Z',
          treeAtStop: 'tree-two',
        }),
        itemRecord({ run: 'run-new', steps: [differsStep(1)] }),
      ),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/check',
        run: 'run-new',
        freshness: { fresh: false, reason: 'treeChangedDuringRun' },
        outcome: 'failed',
        counts: { passed: 0, differs: 1, blocked: 0, notRun: 0 },
      },
    ],
  },
  {
    name: 'results sorted by target then item from an unsorted input',
    runs: [
      runRead(runRecord({ run: 'run-b', target: '483' }), [
        validItem(itemRecord({ run: 'run-b', item: 'journeys/check' })),
      ]),
      runRead(runRecord({ run: 'run-a', target: '482' }), [
        validItem(itemRecord({ run: 'run-a', item: 'journeys/zeta' })),
        validItem(itemRecord({ run: 'run-a', item: 'journeys/alpha' })),
      ]),
    ],
    expected: [
      {
        target: '482',
        item: 'journeys/alpha',
        run: 'run-a',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
      {
        target: '482',
        item: 'journeys/zeta',
        run: 'run-a',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
      {
        target: '483',
        item: 'journeys/check',
        run: 'run-b',
        freshness: fresh,
        outcome: 'passed',
        counts: passedCounts,
      },
    ],
  },
])('selects $name', ({ runs, expected }) => {
  const summaries = selectEvidence(runs, tree).map(summary);
  expect(summaries).toEqual(expected);
});

it.each([
  {
    name: 'all steps and the end state passed',
    steps: [passedStep(1), passedStep(2)],
    endState: { status: 'passed' } satisfies StepOutcome,
    expected: 'passed',
  },
  {
    name: 'one differs step',
    steps: [passedStep(1), differsStep(2)],
    endState: { status: 'passed' } satisfies StepOutcome,
    expected: 'failed',
  },
  {
    name: 'one blocked step with the rest passed',
    steps: [passedStep(1), blockedStep(2)],
    endState: { status: 'passed' } satisfies StepOutcome,
    expected: 'failed',
  },
  {
    name: 'one notRun step with the rest passed',
    steps: [passedStep(1), notRunStep(2)],
    endState: { status: 'passed' } satisfies StepOutcome,
    expected: 'failed',
  },
  {
    name: 'a differs end state',
    steps: [passedStep(1)],
    endState: { status: 'differs', observed: 'The dialog stays open.' } satisfies StepOutcome,
    expected: 'failed',
  },
  {
    name: 'a blocked end state',
    steps: [passedStep(1)],
    endState: { status: 'blocked', reason: 'The page did not load.' } satisfies StepOutcome,
    expected: 'failed',
  },
])('decides the item outcome for $name', ({ steps, endState, expected }) => {
  const [result] = selectEvidence(
    [runWithItem(runRecord(), itemRecord({ steps, endState }))],
    tree,
  );

  expect(result?.outcome).toBe(expected);
});

it.each([
  {
    name: 'a valid run with valid items',
    runs: [runWithItem(runRecord(), itemRecord())],
    expected: [],
  },
  {
    name: 'a malformed run',
    runs: [
      {
        run: 'run-a',
        directory: '/verification/run-a',
        read: { status: 'malformed' as const, problem: 'bad run record' },
        items: [validItem(itemRecord())],
      },
    ],
    expected: [{ run: 'run-a', item: null, problem: 'bad run record' }],
  },
  {
    name: 'a malformed item',
    runs: [
      runRead(runRecord(), [
        {
          item: 'journeys/check',
          path: '/verification/run-a/items/journeys/check.json',
          read: { status: 'malformed' as const, problem: 'bad item record' },
        },
      ]),
    ],
    expected: [{ run: 'run-a', item: 'journeys/check', problem: 'bad item record' }],
  },
  {
    name: 'a missing run',
    runs: [
      {
        run: 'run-a',
        directory: '/verification/run-a',
        read: { status: 'missing' as const },
        items: [],
      },
    ],
    expected: [],
  },
  {
    name: 'a missing item',
    runs: [
      runRead(runRecord(), [
        {
          item: 'journeys/check',
          path: '/verification/run-a/items/journeys/check.json',
          read: { status: 'missing' as const },
        },
      ]),
    ],
    expected: [],
  },
])('lists record problems for $name', ({ runs, expected }) => {
  expect(listRecordProblems(runs)).toEqual(expected);
});

it('counts steps by status', () => {
  const [result] = selectEvidence(
    [
      runWithItem(
        runRecord(),
        itemRecord({ steps: [passedStep(1), differsStep(2), blockedStep(3), notRunStep(4)] }),
      ),
    ],
    tree,
  );

  expect(result?.counts).toEqual({ passed: 1, differs: 1, blocked: 1, notRun: 1 });
});
