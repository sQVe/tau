import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { readWorkerActivity, writeWorkerActivity } from './activity.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('round-trips a worker phase description with its own update time', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-activity-'));
  directories.push(directory);
  const activity = {
    taskId: 'task-a',
    sequence: 2,
    updatedAt: 20,
    phase: 'active' as const,
    label: 'tool: read',
    description: 'Running focused tests',
    descriptionAt: 15,
  };

  writeWorkerActivity(directory, activity);

  expect(readWorkerActivity(directory, 'task-a')).toEqual(activity);
});

it('reads the latest activity only for the matching task identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-activity-'));
  directories.push(directory);
  const activity = {
    taskId: 'task-a',
    sequence: 1,
    updatedAt: 10,
    phase: 'active' as const,
    label: 'tool: read',
    usage: { input: 8, output: 3, cacheRead: 2, cacheWrite: 1 },
  };

  writeWorkerActivity(directory, activity);

  expect(readWorkerActivity(directory, 'task-a')).toEqual(activity);
  expect(readWorkerActivity(directory, 'task-b')).toBeUndefined();
});
