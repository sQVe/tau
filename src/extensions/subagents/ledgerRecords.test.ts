import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import * as cancellationModule from './cancellation.js';
import { WorkerController } from './controller/controller.js';
import type { HerdrClient } from './controller/inspect.js';
import { herdrFake } from './fixtures/herdrFake.js';
import { fixtureLoadout } from './fixtures/loadout.js';
import { createLedgerFixture } from './fixtures/workerLedger.js';
import { readSessionLedger, readWorkerLedger } from './ledgerRecords.js';
import { acceptQuestion } from './questionRecords.js';
import { acceptReport, publish, readTask, recordEvent } from './records.js';

const setup = () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-ledger-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory, ...createLedgerFixture(directory, join(directory, 'workers')) };
};

// Every saved byte under the fixture. A worker action such as a reply or a cancel writes records.
const snapshot = (directory: string) =>
  readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((path) => statSync(join(directory, path)).isFile())
    .map((path) => [path, readFileSync(join(directory, path), 'utf8')]);

// Launches a worker this parent controls through the recording herdr fake. The fake worker reports
// ready at once and keeps running.
const runningWorker = async (fixture: ReturnType<typeof setup>) => {
  vi.stubEnv('PI_CODING_AGENT_DIR', fixture.directory);
  const fake = herdrFake();
  const originalRunClient = cancellationModule.runClient;

  // The fake shells' start times identify their panes.
  vi.spyOn(cancellationModule, 'runClient').mockImplementation(
    (executable, argumentsList, budget, options) =>
      executable === 'ps' && argumentsList[1] === '100'
        ? Promise.resolve('fixture shell start')
        : originalRunClient(executable, argumentsList, budget, options),
  );

  const client: HerdrClient = async (argumentsList, budget, signal) => {
    if (argumentsList[0] === 'layout') {
      const root = (
        JSON.parse(argumentsList[2] ?? '') as {
          root: { command: string[]; env: Record<string, string> };
        }
      ).root;

      fake.state.session = root.command[root.command.indexOf('--session') + 1] ?? '';
      const recordDirectory = root.env.TAU_WORKER_RECORD ?? '';
      const task = readTask(recordDirectory);

      recordEvent(recordDirectory, task.taskId, 'ready', {
        detail: 'Ready.',
        processId: process.pid,
      });
    }

    return fake.client(argumentsList, budget, signal);
  };

  const controller = new WorkerController(fixture.workers, client);

  onTestFinished(() => {
    controller.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const launched = await controller.launch({
    task: 'Edit fixture and test it.',
    loadout: fixtureLoadout(fixture.directory),
    timeout: 60_000,
    parentSession: fixture.current.file,
    parentSessionId: fixture.current.id,
    parentPane: 'parent',
  });

  recordEvent(launched.directory, launched.taskId, 'accepted', { detail: 'Accepted.' });

  return { controller, calls: fake.calls, taskId: launched.taskId };
};

const sessionContext = (current: { file: string; id: string; sessionDirectory: string }) => ({
  sessionManager: {
    getSessionFile: () => current.file,
    getSessionId: () => current.id,
    getSessionDir: () => current.sessionDirectory,
  },
});

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
  const before = snapshot(fixture.directory);

  const ledger = await readWorkerLedger(fixture.workers, fixture.current, (taskId) =>
    owned.has(taskId),
  );

  expect(snapshot(fixture.directory)).toEqual(before);

  expect(ledger).toEqual({
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
    workers: [],
    diagnostics: [],
  });
});

it('keeps readable workers and names a malformed record in the diagnostics', async () => {
  const fixture = setup();
  const corrupt = fixture.task('task-corrupt');
  fixture.task('task-intact');
  writeFileSync(join(corrupt.taskDirectory, 'report.json'), '{}');
  const before = snapshot(fixture.directory);

  const ledger = await readWorkerLedger(fixture.workers, fixture.current, () => true);

  expect(snapshot(fixture.directory)).toEqual(before);

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

it('reads the ledger of the current session without changing its records', async () => {
  const fixture = setup();
  const { taskDirectory } = fixture.task('task-reported');

  acceptReport(taskDirectory, 'task-reported', {
    taskId: 'task-reported',
    outcome: 'success',
    summary: 'Done.',
    evidence: ['diff hash 1f2e3d'],
  });

  const before = snapshot(fixture.directory);

  const ledger = await readSessionLedger(
    sessionContext(fixture.current),
    fixture.workers,
    () => true,
  );

  expect(ledger.workers).toMatchObject([
    { taskId: 'task-reported', report: { outcome: 'success', evidence: ['diff hash 1f2e3d'] } },
  ]);

  expect(ledger.diagnostics).toEqual([]);
  expect(snapshot(fixture.directory)).toEqual(before);
});

it.each([
  { name: 'an unsaved session', file: undefined, removeRecords: false },
  { name: 'missing worker records', file: 'saved', removeRecords: true },
])('reads an empty ledger for $name', async ({ file, removeRecords }) => {
  const fixture = setup();

  if (removeRecords) {
    rmSync(fixture.workers, { recursive: true });
  }

  const context = sessionContext({
    ...fixture.current,
    file: file === undefined ? '' : fixture.current.file,
  });

  const before = snapshot(fixture.directory);

  await expect(readSessionLedger(context, fixture.workers, () => true)).resolves.toEqual({
    workers: [],
    diagnostics: [],
  });

  expect(snapshot(fixture.directory)).toEqual(before);
});

it('names a malformed record of the current session in the diagnostics', async () => {
  const fixture = setup();
  const corrupt = fixture.task('task-corrupt');
  writeFileSync(join(corrupt.taskDirectory, 'report.json'), 'not json');
  const before = snapshot(fixture.directory);

  const ledger = await readSessionLedger(
    sessionContext(fixture.current),
    fixture.workers,
    () => true,
  );

  expect(ledger.workers.map((worker) => worker.taskId)).toEqual(['task-corrupt']);
  expect(ledger.diagnostics.join('\n')).toContain('task-corrupt');
  expect(snapshot(fixture.directory)).toEqual(before);
});

it('refuses a current session whose saved ancestry cannot be read', async () => {
  const fixture = setup();

  const context = sessionContext({
    ...fixture.current,
    file: join(fixture.current.sessionDirectory, 'gone.jsonl'),
  });

  await expect(readSessionLedger(context, fixture.workers, () => true)).rejects.toThrow(
    'Session ancestry is unavailable',
  );
});

it('reads a running worker without worker actions or record changes', async () => {
  const fixture = setup();
  const running = await runningWorker(fixture);
  const ownership = (taskId: string) => running.controller.owns(taskId);
  const callsBefore = structuredClone(running.calls);
  const before = snapshot(fixture.directory);

  const direct = await readWorkerLedger(fixture.workers, fixture.current, ownership);

  const session = await readSessionLedger(
    sessionContext(fixture.current),
    fixture.workers,
    ownership,
  );

  expect(direct.workers).toMatchObject([{ taskId: running.taskId, state: 'running' }]);
  expect(session).toEqual(direct);
  expect(running.calls).toEqual(callsBefore);
  expect(snapshot(fixture.directory)).toEqual(before);
  expect(running.controller.status(running.taskId, fixture.current.id).state).toBe('running');
});
