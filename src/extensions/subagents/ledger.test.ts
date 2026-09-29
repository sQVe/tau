import { expect, it } from 'vitest';

import { buildLedger, renderLedger } from './ledger.js';
import type { Ledger, LedgerWorker, WorkerRecordFacts } from './ledger.js';

interface LedgerCase {
  name: string;
  workers: WorkerRecordFacts[];
  diagnostics: string[];
  ledger: Ledger;
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
