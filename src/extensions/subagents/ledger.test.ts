import { expect, it } from 'vitest';

import { buildLedger, renderLedger, summaryLayout } from './ledger.js';
import type { Ledger, LedgerWorker, WorkerRecordFacts } from './ledger.js';

interface LedgerCase {
  name: string;
  workers: WorkerRecordFacts[];
  diagnostics: string[];
  ledger: Ledger;
}

interface LayoutCase {
  name: string;
  workers: WorkerRecordFacts[];
  full: string[];
  short: string[];
}

const reported: WorkerRecordFacts = {
  taskId: 'task-b',
  name: 'worker-ab',
  label: 'Fix login',
  profile: 'worker',
  state: 'reported',
  successorTaskId: 'task-c',
  report: {
    taskId: 'task-b',
    outcome: 'success',
    summary: 'Done.',
    evidence: ['diff hash 1f2e3d', '.tau/check.log'],
  },
};

const reportedEntry: LedgerWorker = {
  taskId: 'task-b',
  name: 'worker-ab',
  label: 'Fix login',
  profile: 'worker',
  state: 'reported',
  successorTaskId: 'task-c',
  report: { outcome: 'success', evidence: ['diff hash 1f2e3d', '.tau/check.log'] },
};

const cases: LedgerCase[] = [
  {
    name: 'keeps identity, state, successor, and report evidence',
    workers: [reported],
    diagnostics: [],
    ledger: { version: 1, workers: [reportedEntry], diagnostics: [] },
  },
  {
    name: 'keeps a pending question and omits fields the records lack',
    workers: [{ taskId: 'task-a', state: 'awaitingReply', pendingQuestionId: 'question-1' }],
    diagnostics: [],
    ledger: {
      version: 1,
      workers: [{ taskId: 'task-a', state: 'awaitingReply', pendingQuestionId: 'question-1' }],
      diagnostics: [],
    },
  },
  {
    name: 'sorts by task ID and drops native-only sessions without one',
    workers: [reported, { profile: 'scout' }, { taskId: 'task-a' }],
    diagnostics: [],
    ledger: {
      version: 1,
      workers: [{ taskId: 'task-a' }, reportedEntry],
      diagnostics: [],
    },
  },
  {
    name: 'bounds evidence and diagnostics',
    workers: [
      {
        taskId: 'task-a',
        report: {
          taskId: 'task-a',
          outcome: 'failure',
          summary: 'No.',
          evidence: ['x'.repeat(900)],
        },
      },
    ],
    diagnostics: ['one', 'two', 'three', 'four', 'five', 'six', 'y'.repeat(900)],
    ledger: {
      version: 1,
      workers: [
        { taskId: 'task-a', report: { outcome: 'failure', evidence: [`${'x'.repeat(500)}…`] } },
      ],
      diagnostics: ['one', 'two', 'three', 'four', 'five'],
    },
  },
];

it.each(cases)('$name', ({ workers, diagnostics, ledger }) => {
  expect(buildLedger(workers, diagnostics)).toEqual(ledger);
});

it('renders every saved identifier and evidence entry into the summary text', () => {
  const pending = { taskId: 'task-a', state: 'awaitingReply' as const, pendingQuestionId: 'q-7' };
  const text = renderLedger(buildLedger([reported, pending], ['Task task-z report: bad JSON']));

  for (const value of [
    'task-a',
    'q-7',
    'task-b',
    'worker-ab',
    'Fix login',
    'task-c',
    'diff hash 1f2e3d',
    '.tau/check.log',
    'Task task-z report: bad JSON',
  ]) {
    expect(text).toContain(value);
  }
});

const stopped = (
  taskId: string,
  createdAt: number,
): WorkerRecordFacts & { taskId: string; createdAt: number } => ({
  taskId,
  name: `${taskId}-name`,
  state: 'stopped',
  createdAt,
  report: { taskId, outcome: 'success', summary: 'Done.', evidence: [`evidence of ${taskId}`] },
});

// Eleven stopped workers, launched in the order of their number.
const stoppedWorkers = Array.from({ length: 11 }, (_, index) =>
  stopped(`stopped-${String(index + 1).padStart(2, '0')}`, 1000 + index),
);

const recentStopped = stoppedWorkers.slice(1).map((worker) => worker.taskId);

const { createdAt: _unused, ...undated } = stopped('undated', 1);

const layoutCases: LayoutCase[] = [
  {
    name: 'shortens a stopped worker beyond the 10 most recent',
    workers: stoppedWorkers,
    full: recentStopped,
    short: ['stopped-01'],
  },
  {
    name: 'keeps a worker that is not stopped in full however old it is',
    workers: [...stoppedWorkers, { ...stopped('running-old', 1), state: 'running' }],
    full: ['running-old', ...recentStopped],
    short: ['stopped-01'],
  },
  {
    name: 'keeps an unreadable worker in full',
    workers: [...stoppedWorkers, { taskId: 'unreadable-old', createdAt: 1 }],
    full: [...recentStopped, 'unreadable-old'],
    short: ['stopped-01'],
  },
  {
    name: 'keeps a stopped worker with a pending question in full',
    workers: [...stoppedWorkers, { ...stopped('asking-old', 1), pendingQuestionId: 'question-1' }],
    full: ['asking-old', ...recentStopped],
    short: ['stopped-01'],
  },
  {
    name: 'treats a stopped worker without a launch time as the oldest',
    workers: [...stoppedWorkers.slice(1), undated],
    full: recentStopped,
    short: ['undated'],
  },
];

it.each(layoutCases)('$name', ({ workers, full, short }) => {
  const layout = summaryLayout(buildLedger(workers, []));

  expect(layout.full.map((worker) => worker.taskId)).toEqual(full);
  expect(layout.short.map((worker) => worker.taskId)).toEqual(short);
});

it('keeps every worker in full in the details', () => {
  const ledger = buildLedger(stoppedWorkers, []);

  expect(ledger.workers).toHaveLength(11);

  expect(ledger.workers[0]).toEqual({
    taskId: 'stopped-01',
    name: 'stopped-01-name',
    state: 'stopped',
    createdAt: 1000,
    report: { outcome: 'success', evidence: ['evidence of stopped-01'] },
  });
});

it('keeps the task ID and outcome of an older stopped worker in the text, without evidence', () => {
  const text = renderLedger(buildLedger(stoppedWorkers, []));
  const line = text.split('\n').find((entry) => entry.includes('stopped-01')) ?? '';

  expect(line).toContain('stopped-01-name');
  expect(line).toContain('success');
  expect(text).not.toContain('evidence of stopped-01');
  expect(text).toContain('evidence of stopped-11');
});
