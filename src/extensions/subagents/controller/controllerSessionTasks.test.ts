import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join, relative, sep } from 'node:path';

import { expect, it, vi } from 'vitest';

import * as names from '../names.js';
import * as questions from '../questionRecords.js';
import { readTask, recordEvent } from '../records.js';
import { WorkerController } from './controller.js';
import { setup } from './fixtures/controllerFixture.js';

vi.mock(import('node:fs'), { spy: true });

const foreignTaskCount = 2000;

// A root unchanged for a minute counts as settled.
const settledTime = () => new Date(Date.now() - 60_000);

const savedTask = join(import.meta.dirname, '..', 'fixtures', 'taskRecords', 'current-pi.json');

const fileReads = [
  fs.openSync,
  fs.readFileSync,
  fs.readdirSync,
  fs.lstatSync,
  fs.statSync,
  fs.existsSync,
] as const;

const saveForeignTasks = (root: string): Set<string> => {
  const saved = fs.readFileSync(savedTask, 'utf8');
  const taskIds = new Set<string>();

  for (let index = 0; index < foreignTaskCount; index++) {
    const taskId = randomUUID();
    const directory = join(root, taskId);

    fs.mkdirSync(directory);

    const task = {
      ...(JSON.parse(saved) as object),
      taskId,
      nativeSessionId: `native-${taskId}`,
      parentSessionId: 'other-parent',
    };

    fs.writeFileSync(join(directory, 'task.json'), JSON.stringify(task));
    taskIds.add(taskId);
  }

  return taskIds;
};

const foreignReads = (root: string, foreign: Set<string>): string[] =>
  fileReads.flatMap((read) =>
    vi.mocked(read).mock.calls.flatMap(([path]) => {
      const name = relative(root, String(path)).split(sep)[0] ?? '';

      return foreign.has(name) ? [String(path)] : [];
    }),
  );

it('reads only its own session tasks after resume while other sessions saved 2,000', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const foreign = saveForeignTasks(directory);

  await controller.resume(input.parentSessionId);

  for (const read of fileReads) {
    vi.mocked(read).mockClear();
  }

  const launched = await controller.launch(input);

  recordEvent(launched.directory, launched.taskId, 'accepted', 'Accepted.');

  questions.acceptQuestion(launched.directory, launched.taskId, {
    version: 1,
    taskId: launched.taskId,
    questionId: 'question-one',
    question: 'Which file?',
  });

  const rows = controller.widgetRows(input.parentSessionId);
  const status = controller.status(launched.taskId, input.parentSessionId);

  controller.reply(launched.taskId, input.parentSessionId, {
    questionId: 'question-one',
    replyId: 'reply-one',
    reply: 'source.txt',
  });

  const cancelled = await controller.cancel(launched.taskId, input.parentSessionId);

  controller.widgetRows(input.parentSessionId);

  expect(rows.map((row) => row.taskId)).toEqual([launched.taskId]);
  expect(status.pendingQuestion?.questionId).toBe('question-one');
  expect(cancelled.state).toBe('stopped');
  expect(foreignReads(directory, foreign)).toEqual([]);
});

it('shows and keeps the name of a same-session task that another process launched after resume', async ({
  onTestFinished,
}) => {
  const suffix = vi.spyOn(names, 'nameSuffix').mockReturnValue('aa');
  const { controller, client, input, directory } = setup(onTestFinished);
  const other = new WorkerController(directory, client);

  onTestFinished(() => {
    other.close();
  });

  await controller.resume(input.parentSessionId);
  expect(controller.widgetRows(input.parentSessionId)).toEqual([]);

  const elsewhere = await other.launch(input);

  suffix.mockReturnValueOnce('aa').mockReturnValue('bb');
  const launched = await controller.launch(input);

  expect(readTask(elsewhere.directory).name).toBe('worker-aa');
  expect(readTask(launched.directory).name).toBe('worker-bb');

  expect(
    controller
      .widgetRows(input.parentSessionId)
      .map((row) => row.taskId)
      .toSorted(),
  ).toEqual([elsewhere.taskId, launched.taskId].toSorted());
});

it('shows a same-session task whose record another process published into an existing directory', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const taskId = randomUUID();
  const taskDirectory = join(directory, taskId);

  fs.mkdirSync(taskDirectory);
  fs.utimesSync(directory, settledTime(), settledTime());
  expect(controller.widgetRows(input.parentSessionId)).toEqual([]);

  const task = {
    ...(JSON.parse(fs.readFileSync(savedTask, 'utf8')) as object),
    taskId,
    nativeSessionId: `native-${taskId}`,
    parentSessionId: input.parentSessionId,
  };

  fs.writeFileSync(join(taskDirectory, 'task.json'), JSON.stringify(task));

  expect(controller.widgetRows(input.parentSessionId).map((row) => row.taskId)).toEqual([taskId]);
});

it('lists a settled task root only once', async ({ onTestFinished }) => {
  const { controller, input, directory } = setup(onTestFinished);

  saveForeignTasks(directory);
  fs.utimesSync(directory, settledTime(), settledTime());
  controller.widgetRows(input.parentSessionId);
  vi.mocked(fs.readdirSync).mockClear();

  expect(controller.widgetRows(input.parentSessionId)).toEqual([]);
  expect(vi.mocked(fs.readdirSync).mock.calls.filter(([path]) => path === directory)).toEqual([]);
});

it('keeps the old stopped tasks of its own session when a fresh controller deletes expired tasks', async ({
  onTestFinished,
}) => {
  const { input, directory, client } = setup(onTestFinished);
  const saved = JSON.parse(fs.readFileSync(savedTask, 'utf8')) as object;
  const later = Date.now() + 30 * 86_400_000;

  for (const [taskId, parentSessionId] of [
    ['own-task', input.parentSessionId],
    ['foreign-task', 'other-parent'],
  ] as const) {
    const taskDirectory = join(directory, taskId);
    const cleanup = { taskId, kind: 'cleanup', detail: 'Stopped.', stopped: true, at: 1000 };

    fs.mkdirSync(taskDirectory);

    fs.writeFileSync(
      join(taskDirectory, 'task.json'),
      JSON.stringify({ ...saved, taskId, nativeSessionId: `native-${taskId}`, parentSessionId }),
    );

    fs.writeFileSync(join(taskDirectory, 'cleanup.json'), JSON.stringify(cleanup));
  }

  const fresh = new WorkerController(directory, client);

  onTestFinished(() => {
    fresh.close();
  });

  await fresh.resume(input.parentSessionId);

  await expect(fresh.deleteExpiredTasks(input.parentSessionId, later)).resolves.toEqual([
    'foreign-task',
  ]);

  expect(fs.existsSync(join(directory, 'own-task'))).toBe(true);
});

const saveAbandonedDirectories = (root: string, count: number, changedAt: Date): Set<string> => {
  const taskIds = new Set<string>();

  for (let index = 0; index < count; index++) {
    const taskId = randomUUID();

    fs.mkdirSync(join(root, taskId));
    fs.utimesSync(join(root, taskId), changedAt, changedAt);
    taskIds.add(taskId);
  }

  return taskIds;
};

const clearReads = () => {
  for (const read of fileReads) {
    vi.mocked(read).mockClear();
  }
};

it('stops reading abandoned and deleted directories without a task record', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const abandoned = saveAbandonedDirectories(directory, foreignTaskCount, new Date(0));
  const pending = saveAbandonedDirectories(directory, 10, new Date());

  fs.utimesSync(directory, settledTime(), settledTime());
  controller.widgetRows(input.parentSessionId);
  clearReads();

  controller.widgetRows(input.parentSessionId);
  expect(foreignReads(directory, abandoned)).toEqual([]);

  for (const taskId of pending) {
    fs.rmdirSync(join(directory, taskId));
  }

  fs.utimesSync(directory, settledTime(), settledTime());
  controller.widgetRows(input.parentSessionId);
  clearReads();

  controller.widgetRows(input.parentSessionId);
  expect(foreignReads(directory, pending)).toEqual([]);
});

const saveSessionTask = (
  root: string,
  taskId: string,
  saved: { taskId?: string; parentSessionId: string },
) => {
  const task = {
    ...(JSON.parse(fs.readFileSync(savedTask, 'utf8')) as object),
    taskId,
    nativeSessionId: `native-${taskId}`,
    ...saved,
  };

  fs.mkdirSync(join(root, taskId));
  fs.writeFileSync(join(root, taskId, 'task.json'), JSON.stringify(task));
};

it('shows a same-session task that another process published after the root settled', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const taskId = randomUUID();

  fs.utimesSync(directory, settledTime(), settledTime());
  expect(controller.widgetRows(input.parentSessionId)).toEqual([]);

  saveSessionTask(directory, taskId, { parentSessionId: input.parentSessionId });

  expect(controller.widgetRows(input.parentSessionId).map((row) => row.taskId)).toEqual([taskId]);
});

it('leaves out a same-session record saved under another task identity', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);

  saveSessionTask(directory, randomUUID(), {
    taskId: randomUUID(),
    parentSessionId: input.parentSessionId,
  });

  expect(controller.widgetRows(input.parentSessionId)).toEqual([]);
});
