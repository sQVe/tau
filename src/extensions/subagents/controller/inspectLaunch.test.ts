import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { skillTools } from '../../../skillTools.js';
import { fixtureLoadout } from '../fixtures/loadout.js';
import type { Task } from '../types.js';
import {
  prepareTaskDirectory,
  workerArguments,
  workerCommand,
  workerEnvironment,
} from './inspect.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

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

const pi = (directory: string, mode: number) => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'pi'), '#!/bin/sh\n');
  chmodSync(join(directory, 'pi'), mode);

  return join(directory, 'pi');
};

it('starts the worker without waiting for an approval prompt', () => {
  expect(workerArguments(launchTask('/tmp'), [], skillTools)).toContain('--approve');
});

it('runs the first executable pi found on PATH', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-');
  pi(join(root, 'plain'), 0o644);
  const executable = pi(join(root, 'bin'), 0o755);

  vi.stubEnv('PATH', [join(root, 'missing'), join(root, 'plain'), join(root, 'bin')].join(':'));

  expect(workerCommand(launchTask(root), [], skillTools)[0]).toBe(executable);
});

it('fails when PATH holds no executable pi', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-');
  pi(join(root, 'plain'), 0o644);

  vi.stubEnv('PATH', join(root, 'plain'));

  expect(() => workerCommand(launchTask(root), [], skillTools)).toThrow('pi');
});

it('ignores a relative PATH entry', () => {
  const root = temporaryDirectory(onTestFinished, 'tau-launch-');
  const directory = join(root, 'bin');
  pi(directory, 0o755);

  vi.stubEnv('PATH', relative(process.cwd(), directory));

  expect(() => workerCommand(launchTask(root), [], skillTools)).toThrow('pi');
});

it("passes the parent's environment except its working-directory variables", () => {
  vi.stubEnv('PWD', '/somewhere');
  vi.stubEnv('OLDPWD', '/elsewhere');
  vi.stubEnv('TAU_PROBE_VARIABLE', 'kept');

  const environment = workerEnvironment();

  expect(environment.TAU_PROBE_VARIABLE).toBe('kept');
  expect(environment).not.toHaveProperty('PWD');
  expect(environment).not.toHaveProperty('OLDPWD');
});

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
