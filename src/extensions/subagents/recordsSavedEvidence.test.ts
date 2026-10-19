import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { expect, it, onTestFinished as afterTest, vi } from 'vitest';

import * as records from './records.js';

const openDescriptorCount = () => readdirSync('/dev/fd').length;

const taskId = '11111111-1111-4111-8111-111111111111';
const otherTaskId = '22222222-2222-4222-8222-222222222222';

const temporaryDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-records-evidence-'));

  afterTest(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return directory;
};

const savedTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const fixture = JSON.parse(
    readFileSync(new URL('fixtures/taskRecords/current-pi.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;

  return {
    ...fixture,
    taskId,
    nativeSessionId: 'native-session',
    ...overrides,
  };
};

const writeJson = (directory: string, name: string, value: unknown): void => {
  writeFileSync(join(directory, name), JSON.stringify(value));
};

it.for([
  ['a record that is not an object', '5', true],
  ['a task without a predecessor', JSON.stringify({ taskId: otherTaskId }), false],
  ['a task of another source', JSON.stringify({ predecessorTaskId: otherTaskId }), false],
  ['a task of this source', JSON.stringify({ predecessorTaskId: taskId }), true],
  ['a predecessor that is not text', JSON.stringify({ predecessorTaskId: 5 }), true],
  ['a predecessor that is not a task identity', JSON.stringify({ predecessorTaskId: 'a b' }), true],
] as const)('lets a follow-up proceed past %s only as expected', ([, content, expected]) => {
  const directory = temporaryDirectory();

  writeFileSync(join(directory, 'task.json'), content);

  expect(records.mayFollow(directory, taskId)).toBe(expected);
});

it('lets a follow-up proceed past a task record that cannot be read', () => {
  expect(records.mayFollow(temporaryDirectory(), taskId)).toBe(true);
});

it('does not scan the admission directory as a task', () => {
  const root = temporaryDirectory();

  mkdirSync(join(root, '.admission'));
  const diagnostics: string[] = [];
  const skipped: string[] = [];

  expect(records.readTasks(root, diagnostics, skipped)).toEqual([]);
  expect(diagnostics).toEqual([]);
  expect(skipped).toEqual([]);
});

it.for([
  ['an empty directory', [], 'skipped'],
  ['a directory with only publication receipts', ['.receipt-0a1b2c3d-4e5f'], 'skipped'],
  ['a directory with another file', ['notes.txt'], 'diagnostics'],
  ['a directory with an unrelated receipt name', ['.receipt-XYZ'], 'diagnostics'],
] as const)('files %s without a task under the right notice', ([, files, where]) => {
  const root = temporaryDirectory();
  const child = join(root, taskId);

  mkdirSync(child);

  for (const file of files) {
    writeFileSync(join(child, file), '');
  }

  const diagnostics: string[] = [];
  const skipped: string[] = [];

  expect(records.readTasks(root, diagnostics, skipped)).toEqual([]);
  expect(where === 'skipped' ? skipped : diagnostics).toHaveLength(1);
  expect(where === 'skipped' ? diagnostics : skipped).toHaveLength(0);
});

it('does not file a receipt that is a directory as an unpublished task', () => {
  const root = temporaryDirectory();
  const child = join(root, taskId);

  mkdirSync(join(child, '.receipt-0a1b2c3d'), { recursive: true });
  const diagnostics: string[] = [];
  const skipped: string[] = [];

  records.readTasks(root, diagnostics, skipped);

  expect(diagnostics).toHaveLength(1);
  expect(skipped).toHaveLength(0);
});

it('scans a missing records directory silently and reports one that cannot be listed', () => {
  const root = temporaryDirectory();
  const missing: string[] = [];
  const unlistable: string[] = [];
  const file = join(root, 'file');

  writeFileSync(file, '');

  expect(records.readTasks(join(root, 'absent'), missing)).toEqual([]);
  expect(records.readTasks(file, unlistable)).toEqual([]);
  expect(missing).toEqual([]);
  expect(unlistable).toHaveLength(1);
});

it('returns a task once when another directory is still unpublished', () => {
  const root = temporaryDirectory();
  const published = join(root, taskId);

  mkdirSync(published);
  mkdirSync(join(root, otherTaskId));
  records.publish(published, 'task.json', savedTask());
  const skipped: string[] = [];

  const found = records.readTasks(root, [], skipped);

  expect(found.map((entry) => entry.task.taskId)).toEqual([taskId]);
  expect(skipped).toHaveLength(1);
});

it('returns each task once when one follows another and a third directory is unpublished', () => {
  const root = temporaryDirectory();
  const first = join(root, taskId);
  const second = join(root, otherTaskId);

  mkdirSync(first);
  mkdirSync(second);
  mkdirSync(join(root, '33333333-3333-4333-8333-333333333333'));
  records.publish(first, 'task.json', savedTask());

  records.publish(
    second,
    'task.json',
    savedTask({ taskId: otherTaskId, nativeSessionId: 'native-other', predecessorTaskId: taskId }),
  );

  const found = records.readTasks(root, [], []);

  expect(found.map((entry) => entry.task.taskId).toSorted()).toEqual([taskId, otherTaskId]);
});

it.for([
  ['a task that follows itself', { predecessorTaskId: taskId }],
  ['a task whose identity is its native session', { nativeSessionId: taskId }],
  ['a task whose deadline leaves no work time', { deadline: 2000, createdAt: 1000 }],
] as const)('refuses %s', ([, overrides]) => {
  const directory = temporaryDirectory();

  records.publish(directory, 'task.json', savedTask(overrides));

  expect(() => records.readTask(directory)).toThrow(/\S/);
});

it('reads a task that follows another task and leaves work time after cleanup', () => {
  const directory = temporaryDirectory();

  records.publish(
    directory,
    'task.json',
    savedTask({
      predecessorTaskId: otherTaskId,
      deadline: 2001,
      createdAt: 1000,
    }),
  );

  expect(records.readTask(directory).taskId).toBe(taskId);
});

it('closes every descriptor it opens while publishing', () => {
  const directory = temporaryDirectory();

  const before = openDescriptorCount();

  records.publish(directory, 'saved.json', { ok: true });

  expect(openDescriptorCount()).toBe(before);
});

it('keeps worker records under the agent directory in a workers folder', () => {
  const agentDirectory = temporaryDirectory();

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  afterTest(() => {
    vi.unstubAllEnvs();
  });

  const parts = relative(agentDirectory, records.workerRecordsDirectory()).split(sep);

  expect(parts[0]).toBe('tau');
  expect(parts.at(-1)).toBe('workers');
  expect(parts).toHaveLength(3);
});

it('accepts a report that is exactly at the byte limit and refuses one byte more', () => {
  const limit = 64_000;
  const chunk = 'x'.repeat(1000);

  const report = (lastLength: number) => ({
    taskId,
    outcome: 'success',
    summary: 'Done.',
    evidence: [...Array.from({ length: 50 }, () => chunk), 'y'.repeat(lastLength)],
  });

  const base = Buffer.byteLength(JSON.stringify(report(0)));
  const exact = report(limit - base);

  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(limit);
  expect(records.acceptReport(temporaryDirectory(), taskId, exact).taskId).toBe(taskId);

  expect(() =>
    records.acceptReport(temporaryDirectory(), taskId, report(limit - base + 1)),
  ).toThrow(/\S/);
});

it.for([
  [
    'with another task identity',
    {
      taskId: otherTaskId,
      kind: 'cleanup',
      detail: 'x',
      stopped: false,
      at: 1,
    },
  ],
  ['of another kind', { taskId, kind: 'cancelled', detail: 'x', stopped: false, at: 1 }],
  ['without a detail', { taskId, kind: 'cleanup', stopped: false, at: 1 }],
] as const)('refuses a saved cleanup record %s', ([, value]) => {
  const directory = temporaryDirectory();

  writeJson(directory, 'cleanup.json', value);

  expect(() => records.readEvent(directory, taskId, 'cleanup')).toThrow(/\S/);
});

it('saves an event as not stopped unless it says the worker stopped', () => {
  const directory = temporaryDirectory();

  records.recordEvent(directory, taskId, 'cleanup', 'Pane left open.');

  expect(records.readEvent(directory, taskId, 'cleanup')?.stopped).toBe(false);
});

it.for([
  ['a number', 5],
  ['an empty text', ''],
] as const)('refuses a saved pane id that is %s', ([, paneId]) => {
  const directory = temporaryDirectory();

  writeJson(directory, 'pane.json', { paneId });

  expect(() => records.readPane(directory)).toThrow(/\S/);
});
