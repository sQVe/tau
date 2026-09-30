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
  // Task ID, evidence entries shown, and evidence entries omitted, in the order shown.
  full: [string, number, number][];
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

const worker = (
  taskId: string,
  facts: Omit<WorkerRecordFacts, 'taskId' | 'report'> = {},
  evidence: string[] = [`evidence of ${taskId}`],
): WorkerRecordFacts => ({
  taskId,
  name: `${taskId}-name`,
  state: 'stopped',
  ...facts,
  report: { taskId, outcome: 'success', summary: 'Done.', evidence },
});

// The schema allows 100 evidence entries; the ledger keeps 501 characters of each.
const longEvidence = Array.from({ length: 100 }, (_, index) => `${index}`.padEnd(900, 'x'));

// 47 entries of 501 characters fit in the 24,000-character budget; the 48th does not.
const layoutCases: LayoutCase[] = [
  {
    name: 'lists a worker with a question, then live workers, then the newest ended workers',
    workers: [
      worker('stopped-old', { createdAt: 1 }),
      worker('stopped-new', { createdAt: 4 }),
      worker('running', { state: 'running', createdAt: 1 }),
      { taskId: 'unreadable', createdAt: 1 },
      worker('asking', { pendingQuestionId: 'question-1', createdAt: 2 }),
      worker('undated'),
      worker('unowned', { state: 'notOwned', createdAt: 3 }),
      worker('unconfirmed', { state: 'cleanupUnconfirmed', createdAt: 2 }),
    ],
    full: [
      ['asking', 1, 0],
      ['running', 1, 0],
      ['stopped-new', 1, 0],
      ['unowned', 1, 0],
      ['unconfirmed', 1, 0],
      ['stopped-old', 1, 0],
      ['unreadable', 0, 0],
      ['undated', 1, 0],
    ],
    short: [],
  },
  {
    name: 'keeps the evidence that fits and shortens every worker after the budget',
    workers: [
      worker('running-a', { state: 'running' }, longEvidence),
      worker('running-b', { state: 'running' }, longEvidence),
      worker('stopped', { createdAt: 1 }),
    ],
    full: [['running-a', 47, 53]],
    short: ['running-b', 'stopped'],
  },
  {
    name: 'gives a later worker the budget an earlier worker left',
    workers: [
      worker('asking', { pendingQuestionId: 'question-1' }, longEvidence.slice(0, 40)),
      worker('running', { state: 'running' }, longEvidence),
    ],
    full: [
      ['asking', 40, 0],
      ['running', 7, 93],
    ],
    short: [],
  },
];

it.each(layoutCases)('$name', ({ workers, full, short }) => {
  const layout = summaryLayout(buildLedger(workers, []));

  const shown = layout.full.map((entry): [string, number, number] => [
    entry.worker.taskId,
    entry.evidence.length,
    entry.omitted,
  ]);

  expect(shown).toEqual(full);
  expect(layout.short.map((entry) => entry.taskId)).toEqual(short);
});

it('keeps the shown evidence within the budget when every worker has 100 long entries', () => {
  const workers = Array.from({ length: 20 }, (_, index) =>
    worker(`task-${index}`, { state: 'running' }, longEvidence),
  );

  const layout = summaryLayout(buildLedger(workers, []));
  const shown = layout.full.flatMap((entry) => entry.evidence).join('');

  expect(shown.length).toBeGreaterThan(20_000);
  expect(shown.length).toBeLessThanOrEqual(24_000);
});

it('keeps every worker and evidence entry in the details', () => {
  const workers = Array.from({ length: 20 }, (_, index) =>
    worker(`task-${index}`, { state: 'running' }, longEvidence),
  );

  const ledger = buildLedger(workers, []);

  expect(ledger.workers).toHaveLength(20);
  expect(ledger.workers.every((entry) => entry.report?.evidence.length === 100)).toBe(true);
});

it('names the omitted evidence count and keeps identifiers on short lines', () => {
  const text = renderLedger(
    buildLedger(
      [
        worker('asking-a', { pendingQuestionId: 'question-1' }, longEvidence),
        worker('asking-b', { pendingQuestionId: 'question-2', successorTaskId: 'task-next' }),
      ],
      [],
    ),
  );

  const lines = text.split('\n');
  const shortLine = lines.find((line) => line.includes('asking-b')) ?? '';

  expect(lines.some((line) => line.includes('53'))).toBe(true);
  expect(shortLine).toContain('asking-b-name');
  expect(shortLine).toContain('question-2');
  expect(shortLine).toContain('task-next');
  expect(shortLine).toContain('success');
  expect(text).not.toContain('evidence of asking-b');
});
