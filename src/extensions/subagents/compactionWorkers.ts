// Lists the workers a manager must still track after a compaction, from widget rows the caller
// read. tests/structure.test.ts keeps this module pure.

import type { WorkerWidgetRow } from './widget.js';

type CompactionRow = Pick<WorkerWidgetRow, 'taskId' | 'name' | 'state' | 'questionId'>;

export const activeStates = new Set([
  'starting',
  'running',
  'awaitingReply',
  'reported',
  'stopping',
]);

const needsTracking = (row: CompactionRow): boolean =>
  activeStates.has(row.state) || row.questionId !== undefined;

const workerLine = (row: CompactionRow): string => {
  const question = row.questionId === undefined ? '' : ` · pending question ${row.questionId}`;

  return `- ${row.taskId} (${row.name}) · ${row.state}${question}`;
};

// Undefined when no worker needs tracking, so the caller sends nothing.
export const compactionWorkerList = (rows: readonly CompactionRow[]): string | undefined => {
  const tracked = rows.filter((row) => needsTracking(row));

  if (tracked.length === 0) {
    return undefined;
  }

  return [
    'Workers from this session that are still active or have a pending question:',
    ...tracked.map((row) => workerLine(row)),
    'Use subagent_status for reports and subagent_history for finished workers.',
  ].join('\n');
};
