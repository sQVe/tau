import type { Report, WorkerState } from './types.js';

// Builds the worker ledger from records the caller read. tests/structure.test.ts keeps this module
// pure.

export interface WorkerRecordFacts {
  taskId?: string;
  name?: string;
  label?: string;
  profile?: string;
  state?: WorkerState;
  pendingQuestionId?: string;
  successorTaskId?: string;
  report?: Report;
}

export interface LedgerWorker {
  taskId: string;
  name?: string;
  label?: string;
  profile?: string;
  // Absent when the worker's lifecycle records could not be read.
  state?: WorkerState;
  pendingQuestionId?: string;
  successorTaskId?: string;
  report?: { outcome: Report['outcome']; evidence: string[] };
}

// Saved in the compaction entry's details. Bump for any change to the saved fields.
export interface Ledger {
  version: 1;
  workers: LedgerWorker[];
  diagnostics: string[];
}

const evidenceLength = 500;
const diagnosticLength = 300;
const diagnosticCount = 5;

const shorten = (text: string, length: number): string =>
  text.length > length ? `${text.slice(0, length)}…` : text;

const ledgerReport = (report: Report | undefined): Pick<LedgerWorker, 'report'> => {
  if (report === undefined) {
    return {};
  }

  const evidence = report.evidence.map((entry) => shorten(entry, evidenceLength));

  return { report: { outcome: report.outcome, evidence } };
};

const ledgerWorker = ({
  report,
  ...worker
}: WorkerRecordFacts & { taskId: string }): LedgerWorker => ({
  taskId: worker.taskId,
  ...(worker.name === undefined ? {} : { name: worker.name }),
  ...(worker.label === undefined ? {} : { label: worker.label }),
  ...(worker.profile === undefined ? {} : { profile: worker.profile }),
  ...(worker.state === undefined ? {} : { state: worker.state }),
  ...(worker.pendingQuestionId === undefined
    ? {}
    : { pendingQuestionId: worker.pendingQuestionId }),
  ...(worker.successorTaskId === undefined ? {} : { successorTaskId: worker.successorTaskId }),
  ...ledgerReport(report),
});

const hasTaskId = (worker: WorkerRecordFacts): worker is WorkerRecordFacts & { taskId: string } =>
  worker.taskId !== undefined;

export const buildLedger = (workers: WorkerRecordFacts[], diagnostics: string[]): Ledger => ({
  version: 1,
  workers: workers
    .filter(hasTaskId)
    .toSorted((left, right) => left.taskId.localeCompare(right.taskId))
    .map(ledgerWorker),
  diagnostics: diagnostics
    .slice(0, diagnosticCount)
    .map((entry) => shorten(entry, diagnosticLength)),
});

const workerHeading = (worker: LedgerWorker): string => {
  const quotedLabel = worker.label === undefined ? undefined : `"${worker.label}"`;
  const names = [worker.name, quotedLabel].filter((part) => part !== undefined);

  const identity = names.length > 0 ? ` (${names.join(', ')})` : '';
  const profile = worker.profile ?? 'unknown';
  const state = worker.state ?? 'unreadable';

  return `- Task ${worker.taskId}${identity}: profile ${profile}, state ${state}`;
};

const workerLines = (worker: LedgerWorker): string[] => {
  const lines = [workerHeading(worker)];

  if (worker.pendingQuestionId !== undefined) {
    lines.push(`  - Pending question: ${worker.pendingQuestionId}`);
  }

  if (worker.successorTaskId !== undefined) {
    lines.push(`  - Continued as task ${worker.successorTaskId}`);
  }

  if (worker.report !== undefined) {
    lines.push(`  - Report: ${worker.report.outcome}`);

    for (const entry of worker.report.evidence) {
      lines.push(`    - Evidence: ${entry}`);
    }
  }

  return lines;
};

export const renderLedger = (ledger: Ledger): string => {
  const lines = [
    '## Tau worker ledger',
    '',
    'Tau rebuilt this list from saved worker records. Use these task IDs, question IDs, and evidence exactly.',
    '',
  ];

  if (ledger.workers.length === 0) {
    lines.push('- No workers in this session.');
  }

  for (const worker of ledger.workers) {
    lines.push(...workerLines(worker));
  }

  if (ledger.diagnostics.length > 0) {
    lines.push('', 'Unreadable worker records:');

    for (const entry of ledger.diagnostics) {
      lines.push(`- ${entry}`);
    }
  }

  return lines.join('\n');
};
