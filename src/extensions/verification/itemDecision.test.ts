import { expect, it } from 'vitest';

import type { RecordRead, RunRecord } from '../../verification/records.js';
import { decideItemWrite } from './itemDecision.js';
import type { ItemDecision, ItemFacts } from './itemDecision.js';
import type { RecordInput } from './recordParameters.js';

const run = 'delegate-a-check';
const item = 'journeys/delegate-a-check';

const runRecord = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  version: 1,
  run,
  target: '482',
  head: '1111111111111111111111111111111111111111',
  dirty: false,
  platform: { os: 'linux', arch: 'x64' },
  startedAt: '2026-11-16T10:00:00.000Z',
  treeAtLaunch: '2222222222222222222222222222222222222222',
  treeAtStop: '3333333333333333333333333333333333333333',
  launch: { exitCode: 0, logPath: 'launch.log' },
  doctor: { exitCode: 0, logPath: 'doctor.log' },
  stop: null,
  items: [{ item, steps: 2 }],
  ...overrides,
});

const validRunRead = (overrides: Partial<RunRecord> = {}): RecordRead<RunRecord> => ({
  status: 'valid',
  record: runRecord(overrides),
});

const steps: RecordInput['steps'] = [
  { status: 'passed', artifacts: [] },
  { status: 'differs', observed: 'The dialog stays open.', artifacts: [] },
];

const facts = (overrides: Partial<ItemFacts> = {}): ItemFacts => ({
  run,
  runRead: validRunRead(),
  item,
  steps,
  endState: { status: 'passed' },
  itemFileExists: false,
  artifacts: [],
  ...overrides,
});

const table: { name: string; facts: ItemFacts; expected: ItemDecision }[] = [
  {
    name: 'refuses a missing run record',
    facts: facts({ runRead: { status: 'missing' } }),
    expected: {
      kind: 'refuse',
      reason: `Run ${run} has no run.json; the manager launches a run first.`,
    },
  },
  {
    name: 'refuses a malformed run record',
    facts: facts({ runRead: { status: 'malformed', problem: 'not JSON' } }),
    expected: {
      kind: 'refuse',
      reason: `Run ${run} has a malformed run.json: not JSON`,
    },
  },
  {
    name: 'refuses a run record that names another run',
    facts: facts({ runRead: validRunRead({ run: 'other-run' }) }),
    expected: {
      kind: 'refuse',
      reason: `Run ${run} has a malformed run.json: it names run other-run.`,
    },
  },
  {
    name: 'refuses a stopped run',
    facts: facts({ runRead: validRunRead({ stop: { exitCode: 0, logPath: 'stop.log' } }) }),
    expected: {
      kind: 'refuse',
      reason: `Run ${run} is stopped; record results before the manager stops it.`,
    },
  },
  {
    name: 'refuses a stopped run before an unregistered item',
    facts: facts({
      runRead: validRunRead({
        stop: { exitCode: 0, logPath: 'stop.log' },
        items: [{ item: 'journeys/other', steps: 2 }],
      }),
    }),
    expected: {
      kind: 'refuse',
      reason: `Run ${run} is stopped; record results before the manager stops it.`,
    },
  },
  {
    name: 'writes a result on a run whose saved stop failed',
    facts: facts({ runRead: validRunRead({ stop: { exitCode: 7, logPath: 'stop.log' } }) }),
    expected: {
      kind: 'write',
      record: {
        run,
        item,
        drive: 'hand',
        steps: [
          { number: 1, status: 'passed', artifacts: [] },
          {
            number: 2,
            status: 'differs',
            observed: 'The dialog stays open.',
            artifacts: [],
          },
        ],
        endState: { status: 'passed' },
      },
    },
  },
  {
    name: 'refuses an unregistered item',
    facts: facts({ runRead: validRunRead({ items: [{ item: 'journeys/other', steps: 2 }] }) }),
    expected: {
      kind: 'refuse',
      reason: `Item ${item} is not registered in run ${run}. Registered: journeys/other.`,
    },
  },
  {
    name: 'refuses an unregistered item before an existing item file',
    facts: facts({
      runRead: validRunRead({ items: [{ item: 'journeys/other', steps: 2 }] }),
      itemFileExists: true,
    }),
    expected: {
      kind: 'refuse',
      reason: `Item ${item} is not registered in run ${run}. Registered: journeys/other.`,
    },
  },
  {
    name: 'lists every registered item in the unregistered refusal',
    facts: facts({
      runRead: validRunRead({
        items: [
          { item: 'journeys/one', steps: 1 },
          { item: 'journeys/two', steps: 1 },
        ],
      }),
    }),
    expected: {
      kind: 'refuse',
      reason: `Item ${item} is not registered in run ${run}. Registered: journeys/one, journeys/two.`,
    },
  },
  {
    name: 'says none when the run registers no items',
    facts: facts({ runRead: validRunRead({ items: [] }) }),
    expected: {
      kind: 'refuse',
      reason: `Item ${item} is not registered in run ${run}. Registered: none.`,
    },
  },
  {
    name: 'refuses a wrong step count',
    facts: facts({ steps: steps.slice(0, 1) }),
    expected: {
      kind: 'refuse',
      reason: `Item ${item} has 2 registered steps in run ${run}, but 1 results were given.`,
    },
  },
  {
    name: 'refuses a wrong step count before a missing end state',
    facts: facts({ steps: steps.slice(0, 1), endState: undefined }),
    expected: {
      kind: 'refuse',
      reason: `Item ${item} has 2 registered steps in run ${run}, but 1 results were given.`,
    },
  },
  {
    name: 'refuses a missing end state',
    facts: facts({ endState: undefined }),
    expected: { kind: 'refuse', reason: `Item ${item} needs an endState result.` },
  },
  {
    name: 'refuses an existing item file',
    facts: facts({ itemFileExists: true }),
    expected: {
      kind: 'refuse',
      reason: `Item ${item} already has a result in run ${run}. Each item is recorded once.`,
    },
  },
  {
    name: 'refuses an artifact outside the run directory',
    facts: facts({
      artifacts: [{ step: 1, path: '../outside.png', location: 'outside' }],
    }),
    expected: {
      kind: 'refuse',
      reason: 'Step 1 artifact ../outside.png is outside the run directory.',
    },
  },
  {
    name: 'refuses a missing artifact',
    facts: facts({
      artifacts: [{ step: 1, path: 'screenshots/step-1.png', location: 'missing' }],
    }),
    expected: {
      kind: 'refuse',
      reason: 'Step 1 artifact screenshots/step-1.png does not exist in the run directory.',
    },
  },
  {
    name: 'refuses an unreadable artifact',
    facts: facts({
      artifacts: [{ step: 1, path: 'screenshots/step-1.png', location: 'unreadable' }],
    }),
    expected: {
      kind: 'refuse',
      reason: 'Step 1 artifact screenshots/step-1.png cannot be read in the run directory.',
    },
  },
  {
    name: 'writes a hand result with numbered steps',
    facts: facts(),
    expected: {
      kind: 'write',
      record: {
        run,
        item,
        drive: 'hand',
        steps: [
          { number: 1, status: 'passed', artifacts: [] },
          {
            number: 2,
            status: 'differs',
            observed: 'The dialog stays open.',
            artifacts: [],
          },
        ],
        endState: { status: 'passed' },
      },
    },
  },
];

it.each(table)('$name', ({ facts: itemFacts, expected }) => {
  expect(decideItemWrite(itemFacts)).toEqual(expected);
});
