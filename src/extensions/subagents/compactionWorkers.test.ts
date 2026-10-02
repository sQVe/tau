import { expect, it } from 'vitest';

import { compactionWorkerList } from './compactionWorkers.js';

const row = { taskId: 'task-1', name: 'scout-1', state: 'running' as const };

it.each([
  { name: 'lists a running worker', rows: [row], listed: ['task-1'] },
  {
    name: 'lists a reported worker that has not stopped',
    rows: [{ ...row, state: 'reported' as const }],
    listed: ['task-1'],
  },
  {
    name: 'lists a pending question',
    rows: [{ ...row, state: 'awaitingReply' as const, questionId: 'question-1' }],
    listed: ['task-1', 'question-1'],
  },
  {
    name: 'lists a stopped worker with an unanswered question',
    rows: [{ ...row, state: 'stopped' as const, questionId: 'question-1' }],
    listed: ['task-1', 'question-1'],
  },
  {
    name: 'lists a worker this parent could not reattach',
    rows: [{ ...row, state: 'notOwned' as const }],
    listed: ['task-1'],
  },
  {
    name: 'lists a worker whose cleanup is unconfirmed',
    rows: [{ ...row, state: 'cleanupUnconfirmed' as const }],
    listed: ['task-1'],
  },
  {
    name: 'lists a worker whose status could not be read',
    rows: [{ ...row, state: 'unknown' as const }],
    listed: ['task-1'],
  },
])('$name', ({ rows, listed }) => {
  const list = compactionWorkerList(rows);

  for (const identifier of listed) {
    expect(list).toContain(identifier);
  }
});

it.each([
  { name: 'sends nothing without workers', rows: [] },
  { name: 'skips a stopped worker', rows: [{ ...row, state: 'stopped' as const }] },
])('$name', ({ rows }) => {
  expect(compactionWorkerList(rows)).toBeUndefined();
});

it('lists only the workers that need tracking', () => {
  const list = compactionWorkerList([row, { ...row, taskId: 'task-2', state: 'stopped' }]);

  expect(list).toContain('task-1');
  expect(list).not.toContain('task-2');
});
