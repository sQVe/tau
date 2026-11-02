import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import type { Task } from '../types.js';
import { prepareTaskDirectory } from './inspect.js';

const launchTask = (directory: string): Task =>
  ({
    taskId: 'task',
    version: 11,
    nativeSessionId: 'native',
    nativeSessionFile: join(directory, 'native.jsonl'),
    createdAt: 1000,
    parentSession: '/tmp/parent.jsonl',
    loadout: fixtureLoadout(directory),
  }) as Task;

it('prepares a private task directory below missing parents with a seeded session', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-');
  const directory = join(root, 'missing', 'task');
  const task = launchTask(directory);

  prepareTaskDirectory(directory, task, false);

  expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(readFileSync(task.nativeSessionFile, 'utf8')).toContain('"type":"session"');
});

it('keeps the saved session of a follow-up', () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-launch-');
  const task = launchTask(directory);

  prepareTaskDirectory(directory, task, true);

  expect(() => readFileSync(task.nativeSessionFile, 'utf8')).toThrow('ENOENT');
});
