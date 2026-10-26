import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { execInGroup, groupState } from './process.js';

const startDelayMilliseconds = 200;

const markingCommand = (marker: string) => [
  '-e',
  "require('node:fs').writeFileSync(process.argv[1], '')",
  marker,
];

it('returns the output and exit status of the command', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-group-command-');

  const result = await execInGroup(
    process.execPath,
    ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
    { cwd: directory, onStarted: async () => undefined },
  );

  expect(result).toEqual({ stdout: 'out', stderr: 'err', code: 3, killed: false });
});

it('starts the command only after its group is recorded', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-group-command-');
  const marker = join(directory, 'started');
  const seen: { state?: string; started?: boolean } = {};

  await execInGroup(process.execPath, markingCommand(marker), {
    cwd: directory,
    onStarted: async (groupId) => {
      await sleep(startDelayMilliseconds);
      seen.state = await groupState(groupId);
      seen.started = existsSync(marker);
    },
  });

  expect(seen).toEqual({ state: 'running', started: false });
  expect(existsSync(marker)).toBe(true);
});

it('never starts the command when recording its group fails', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-group-command-');
  const marker = join(directory, 'started');
  let recordedGroup = 0;

  const run = execInGroup(process.execPath, markingCommand(marker), {
    cwd: directory,
    onStarted: async (groupId) => {
      recordedGroup = groupId;

      throw new Error('The lock refused the record.');
    },
  });

  await expect(run).rejects.toThrow('The lock refused the record.');
  expect(existsSync(marker)).toBe(false);
  expect(await groupState(recordedGroup)).toBe('gone');
});

it('never starts the command when the signal aborts before its group is recorded', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-group-command-');
  const marker = join(directory, 'started');
  const controller = new AbortController();

  const result = await execInGroup(process.execPath, markingCommand(marker), {
    cwd: directory,
    signal: controller.signal,
    onStarted: async () => {
      controller.abort();
    },
  });

  expect(result.killed).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

it('stops the command group when the signal aborts', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-group-command-');
  const controller = new AbortController();
  let recordedGroup = 0;

  const result = await execInGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: directory,
    signal: controller.signal,
    onStarted: async (groupId) => {
      recordedGroup = groupId;

      setTimeout(() => {
        controller.abort();
      }, startDelayMilliseconds);
    },
  });

  expect(result.killed).toBe(true);
  expect(await groupState(recordedGroup)).toBe('gone');
});

it('starts the command without launching the current executable', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-group-command-');
  const nodePath = process.execPath;
  const executable = Object.getOwnPropertyDescriptor(process, 'execPath');

  Object.defineProperty(process, 'execPath', { ...executable, value: join(directory, 'missing') });

  onTestFinished(() => {
    Object.defineProperty(process, 'execPath', executable ?? {});
  });

  const result = await execInGroup(nodePath, ['-e', "process.stdout.write('out')"], {
    cwd: directory,
    onStarted: async () => undefined,
  });

  expect(result).toEqual({ stdout: 'out', stderr: '', code: 0, killed: false });
});
