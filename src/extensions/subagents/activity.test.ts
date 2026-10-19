import * as fileSystem from 'node:fs';
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { parsePhaseDescription, readWorkerActivity, writeWorkerActivity } from './activity.js';

vi.mock(import('node:fs'), { spy: true });

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();

  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const openDescriptorCount = () => readdirSync('/dev/fd').length;

const plainActivity = {
  taskId: 'task-a',
  sequence: 1,
  updatedAt: 10,
  phase: 'active' as const,
  label: 'tool: read',
};

it('accepts a phase description at the length limit', () => {
  const description = 'a'.repeat(200);

  expect(parsePhaseDescription(description)).toBe(description);
});

it('refuses a phase description past the length limit', () => {
  expect(() => parsePhaseDescription('a'.repeat(201))).toThrow('at most');
});

it('writes activity without leaving a descriptor open', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-activity-'));
  directories.push(directory);

  const before = openDescriptorCount();

  writeWorkerActivity(directory, plainActivity);

  expect(openDescriptorCount()).toBe(before);
});

it('reports a failed activity write and removes its temporary file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-activity-'));
  directories.push(directory);

  vi.mocked(fileSystem.fsyncSync).mockImplementationOnce(() => {
    throw new Error('Disk full.');
  });

  const before = openDescriptorCount();

  expect(() => {
    writeWorkerActivity(directory, plainActivity);
  }).toThrow('Disk full.');

  expect(openDescriptorCount()).toBe(before);
  expect(readdirSync(directory)).toEqual([]);
});

it('reports a failed activity replace and removes its temporary file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tau-activity-'));
  directories.push(directory);
  mkdirSync(join(directory, 'activity.json', 'blocked'), { recursive: true });

  expect(() => {
    writeWorkerActivity(directory, plainActivity);
  }).toThrow('EISDIR');

  expect(readdirSync(directory)).toEqual(['activity.json']);
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
