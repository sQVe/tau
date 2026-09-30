import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { fixtureLoadout } from './fixtures/loadout.js';
import { readWorkerLedger } from './ledgerRecords.js';
import { acceptQuestion } from './questionRecords.js';
import { acceptReport, publish, recordEvent, validateTask } from './records.js';

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-ledger-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const sessions = join(directory, 'sessions');
  const workers = join(directory, 'workers');
  mkdirSync(sessions);
  mkdirSync(workers);

  const session = (id: string, path: string, parentSession?: string) => {
    const header = {
      type: 'session',
      version: 3,
      id,
      timestamp: new Date(0).toISOString(),
      cwd: directory,
      ...(parentSession === undefined ? {} : { parentSession }),
    };

    writeFileSync(path, `${JSON.stringify(header)}\n`);

    return path;
  };

  const manager = session('manager', join(sessions, 'manager.jsonl'));
  const current = { file: manager, id: 'manager', sessionDirectory: sessions };

  const task = (taskId: string, extra: Record<string, unknown> = {}) => {
    const taskDirectory = join(workers, taskId);
    mkdirSync(taskDirectory);

    const nativeSessionFile = session(
      `native-${taskId}`,
      join(taskDirectory, 'native.jsonl'),
      manager,
    );

    const record = validateTask({
      version: 6,
      taskId,
      task: 'Inspect shared source.',
      parentSession: manager,
      parentSessionId: 'manager',
      nativeSessionId: `native-${taskId}`,
      nativeSessionFile,
      createdAt: 1000,
      deadline: 20000,
      cancellationBudget: 1000,
      monotonicDeadline: 20000,
      loadout: fixtureLoadout(directory),
      ...extra,
    });

    publish(taskDirectory, 'task.json', record);
    recordEvent(taskDirectory, taskId, 'accepted', { detail: 'Accepted.' });

    return { taskDirectory, record };
  };

  return { workers, current, task };
};

it('lists saved workers with state, questions, successors, and report evidence', async () => {
  const fixture = setup();
  const reported = fixture.task('task-reported', { name: 'worker-ab', label: 'Fix login' });

  acceptReport(reported.taskDirectory, 'task-reported', {
    taskId: 'task-reported',
    outcome: 'success',
    summary: 'Done.',
    evidence: ['diff hash 1f2e3d', '.tau/check.log'],
  });

  recordEvent(reported.taskDirectory, 'task-reported', 'cleanup', {
    detail: 'Pane removed.',
    stopped: true,
  });

  const asking = fixture.task('task-asking');

  acceptQuestion(asking.taskDirectory, 'task-asking', {
    version: 1,
    taskId: 'task-asking',
    questionId: 'question-7',
    question: 'Which file?',
  });

  // A follow-up continues the predecessor's native session.
  const successorDirectory = join(fixture.workers, 'task-successor');
  mkdirSync(successorDirectory);

  publish(successorDirectory, 'task.json', {
    ...reported.record,
    taskId: 'task-successor',
    name: 'worker-cd',
    predecessorTaskId: 'task-reported',
  });

  const owned = new Set(['task-reported', 'task-asking', 'task-successor']);

  const ledger = await readWorkerLedger(fixture.workers, fixture.current, (taskId) =>
    owned.has(taskId),
  );

  expect(ledger).toEqual({
    version: 1,
    workers: [
      {
        taskId: 'task-asking',
        profile: 'worker',
        state: 'awaitingReply',
        pendingQuestionId: 'question-7',
        createdAt: 1000,
      },
      {
        taskId: 'task-reported',
        name: 'worker-ab',
        label: 'Fix login',
        profile: 'worker',
        state: 'stopped',
        successorTaskId: 'task-successor',
        createdAt: 1000,
        report: { outcome: 'success', evidence: ['diff hash 1f2e3d', '.tau/check.log'] },
      },
      {
        taskId: 'task-successor',
        name: 'worker-cd',
        label: 'Fix login',
        profile: 'worker',
        state: 'starting',
        createdAt: 1000,
      },
    ],
    diagnostics: [],
  });
});

it('returns an empty ledger when no worker records exist', async () => {
  const fixture = setup();
  rmSync(fixture.workers, { recursive: true });

  await expect(readWorkerLedger(fixture.workers, fixture.current, () => false)).resolves.toEqual({
    version: 1,
    workers: [],
    diagnostics: [],
  });
});

it('keeps readable workers and names a malformed record in the diagnostics', async () => {
  const fixture = setup();
  const corrupt = fixture.task('task-corrupt');
  fixture.task('task-intact');
  writeFileSync(join(corrupt.taskDirectory, 'report.json'), '{}');

  const ledger = await readWorkerLedger(fixture.workers, fixture.current, () => true);

  expect(ledger.workers.map((worker) => worker.taskId)).toEqual(['task-corrupt', 'task-intact']);
  expect(ledger.workers[0]).not.toHaveProperty('report');
  expect(ledger.diagnostics.join('\n')).toContain('task-corrupt');
});

it('refuses a session whose saved ancestry cannot be read', async () => {
  const fixture = setup();

  const missing = {
    ...fixture.current,
    file: join(fixture.current.sessionDirectory, 'gone.jsonl'),
  };

  await expect(readWorkerLedger(fixture.workers, missing, () => false)).rejects.toThrow(
    'Session ancestry is unavailable',
  );
});
