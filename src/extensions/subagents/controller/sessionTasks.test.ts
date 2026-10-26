import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import * as decisions from './discoveryDecision.js';
import { SessionTaskIndex } from './sessionTasks.js';

vi.mock(import('node:fs'), { spy: true });
vi.mock(import('./discoveryDecision.js'), { spy: true });

const savedTask = join(import.meta.dirname, '..', 'fixtures', 'taskRecords', 'current-pi.json');

const saveTask = (directory: string, taskId: string, parentSessionId: string) => {
  const task = {
    ...(JSON.parse(readFileSync(savedTask, 'utf8')) as object),
    taskId,
    nativeSessionId: `native-${taskId}`,
    parentSessionId,
  };

  writeFileSync(join(directory, 'task.json'), JSON.stringify(task));
};

const taskReads = (directory: string): number =>
  vi.mocked(fs.openSync).mock.calls.filter(([path]) => path === join(directory, 'task.json'))
    .length;

const abandonedAt = new Date(0);

// A root unchanged for a minute counts as settled.
const settle = (root: string) => {
  const settledAt = new Date(Date.now() - 60_000);

  utimesSync(root, settledAt, settledAt);
};

const saveDirectories = (root: string, count: number, changedAt?: Date): string[] =>
  Array.from({ length: count }, () => {
    const taskId = randomUUID();

    mkdirSync(join(root, taskId));

    if (changedAt !== undefined) {
      utimesSync(join(root, taskId), changedAt, changedAt);
    }

    return taskId;
  });

const decisionCalls = () =>
  vi.mocked(decisions.discoverTask).mock.calls.length +
  vi.mocked(decisions.retriesPending).mock.calls.length;

it('decides nothing for abandoned directories on a settled read', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-session-tasks-');
  const start = Date.now();
  let now = start;
  const index = new SessionTaskIndex(root, () => now);

  saveDirectories(root, 1000, abandonedAt);
  saveDirectories(root, 1000);
  settle(root);
  index.taskIds('parent');

  now = start + decisions.publicationWindow + 60_000;
  index.taskIds('parent');
  vi.mocked(decisions.discoverTask).mockClear();
  vi.mocked(decisions.retriesPending).mockClear();

  index.taskIds('parent');
  index.taskIds('parent');

  expect(decisionCalls()).toBe(0);
});

it('opens no file of a known foreign or abandoned directory when the root changes', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-session-tasks-');
  const start = Date.now();
  let now = start;
  const index = new SessionTaskIndex(root, () => now);

  const known = new Set([
    ...saveDirectories(root, 100, abandonedAt),
    ...saveDirectories(root, 100),
  ]);

  for (const taskId of saveDirectories(root, 100)) {
    saveTask(join(root, taskId), taskId, 'other-parent');
    known.add(taskId);
  }

  settle(root);
  index.taskIds('parent');
  now = start + decisions.publicationWindow + 60_000;
  index.taskIds('parent');
  mkdirSync(join(root, randomUUID()));
  vi.mocked(fs.openSync).mockClear();
  vi.mocked(fs.statSync).mockClear();

  index.taskIds('parent');

  const opened = [...vi.mocked(fs.openSync).mock.calls, ...vi.mocked(fs.statSync).mock.calls]
    .map(
      ([path]) =>
        String(path)
          .slice(root.length + 1)
          .split('/')[0] ?? '',
    )
    .filter((name) => known.has(name));

  expect(opened).toEqual([]);
});

it('reads a recent foreign directory until its task is published, then stops', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-session-tasks-');
  const taskId = randomUUID();
  const directory = join(root, taskId);
  const index = new SessionTaskIndex(root);

  mkdirSync(directory);
  settle(root);
  index.taskIds('parent');
  saveTask(directory, taskId, 'other-parent');

  expect(index.taskIds('other-parent')).toEqual(new Set([taskId]));

  vi.mocked(fs.openSync).mockClear();
  index.taskIds('parent');
  index.taskIds('parent');

  expect(taskReads(directory)).toBe(0);
});

it('reads a malformed task record once, even after the root changes', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-session-tasks-');
  const directory = join(root, randomUUID());
  const index = new SessionTaskIndex(root);

  mkdirSync(directory);
  writeFileSync(join(directory, 'task.json'), '{');
  settle(root);
  vi.mocked(fs.openSync).mockClear();

  index.taskIds('parent');
  mkdirSync(join(root, randomUUID()));
  index.taskIds('parent');
  index.taskIds('parent');

  expect(taskReads(directory)).toBe(1);
});

it('refuses when the task root cannot be listed', () => {
  const root = join(temporaryDirectory(onTestFinished, 'tau-session-tasks-'), 'workers');

  writeFileSync(root, '');

  expect(() => new SessionTaskIndex(root).taskIds('parent')).toThrow('ENOTDIR');
});

it('stops reading a pending directory once the publication window passes', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-session-tasks-');
  const directory = join(root, randomUUID());
  const start = Date.now();
  let now = start;
  const index = new SessionTaskIndex(root, () => now);

  mkdirSync(directory);
  settle(root);
  index.taskIds('parent');
  vi.mocked(fs.openSync).mockClear();

  index.taskIds('parent');
  expect(taskReads(directory)).toBe(1);

  // The directory was created after the start time, so the window passes a little later.
  now = start + decisions.publicationWindow + 60_000;
  index.taskIds('parent');
  index.taskIds('parent');

  expect(taskReads(directory)).toBe(1);
});

it('stops reading session tasks that another process removed', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-session-tasks-');
  const index = new SessionTaskIndex(root);
  const removed = saveDirectories(root, 100);

  for (const taskId of removed) {
    saveTask(join(root, taskId), taskId, 'parent');
  }

  expect(index.tasks('parent')).toHaveLength(100);

  for (const taskId of removed) {
    fs.rmSync(join(root, taskId), { recursive: true });
  }

  index.tasks('parent');
  vi.mocked(fs.openSync).mockClear();

  expect(index.tasks('parent')).toEqual([]);
  expect(removed.filter((taskId) => taskReads(join(root, taskId)) > 0)).toEqual([]);
});

it.each(['foreign', 'abandoned'] as const)(
  'forgets removed %s directories before the next root change',
  (kind) => {
    const root = temporaryDirectory(onTestFinished, 'tau-session-tasks-');
    const index = new SessionTaskIndex(root);
    const removed = saveDirectories(root, 100, kind === 'abandoned' ? abandonedAt : undefined);

    if (kind === 'foreign') {
      for (const taskId of removed) {
        saveTask(join(root, taskId), taskId, 'other-parent');
      }
    }

    index.taskIds('parent');

    for (const taskId of removed) {
      fs.rmSync(join(root, taskId), { recursive: true });
    }

    index.taskIds('parent');
    mkdirSync(join(root, randomUUID()));

    const lookups = vi.spyOn(Set.prototype, 'has');

    try {
      index.taskIds('parent');

      const visited = new Set(lookups.mock.calls.map(([name]) => String(name)));

      expect(removed.filter((taskId) => visited.has(taskId))).toEqual([]);
    } finally {
      lookups.mockRestore();
    }
  },
);
