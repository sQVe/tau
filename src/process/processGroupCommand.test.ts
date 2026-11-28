import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { execInGroup, groupState } from './process.js';

vi.mock(import('node:child_process'), async (importOriginal) => {
  const original = await importOriginal();
  const { promisify: asPromise } = await import('node:util');
  const executePromise = asPromise(original.execFile);

  const execute = Object.assign(
    (...argumentsList: Parameters<typeof original.execFile>) => original.execFile(...argumentsList),
    {
      [asPromise.custom]: vi.fn<typeof executePromise>(executePromise),
    },
  );

  return {
    ...original,
    execFile: execute as unknown as typeof original.execFile,
    spawn: vi.fn<typeof original.spawn>(original.spawn) as unknown as typeof original.spawn,
  };
});

vi.mock(import('node:timers/promises'), async (importOriginal) => ({
  ...(await importOriginal()),
  setTimeout: (await import('../../tests/timerFake.js')).globalTimerDelay,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

const spawnMock = vi.mocked(spawn);

const startDelayMilliseconds = 200;

// Three bytes per character. A full pipe read is 64 KiB, which is not a multiple of 3, so a large
// output almost always splits characters across reads.
const multibyteRepeatCount = 300000;

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

  expect(result).toEqual({
    stdout: 'out',
    stderr: 'err',
    code: 3,
    killed: false,
    truncated: false,
  });
});

it('keeps a multibyte character that spans two output chunks', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-group-command-');

  const script = [
    `process.stdout.write('€'.repeat(${multibyteRepeatCount}));`,
    `process.stderr.write('漢'.repeat(${multibyteRepeatCount}));`,
  ].join('\n');

  const result = await execInGroup(process.execPath, ['-e', script], {
    cwd: directory,
    onStarted: async () => undefined,
  });

  expect(result.code).toBe(0);
  expect(result.killed).toBe(false);
  expect(result.stdout).toBe('€'.repeat(multibyteRepeatCount));
  expect(result.stderr).toBe('漢'.repeat(multibyteRepeatCount));
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

  expect(result).toEqual({ stdout: 'out', stderr: '', code: 0, killed: false, truncated: false });
});

it('keeps at most the output cap across both streams and keeps draining', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-group-command-');
  const marker = join(directory, 'finished');

  const script = [
    "const fs = require('node:fs');",
    "process.stdout.write('a'.repeat(700000), () => {",
    "  process.stderr.write('b'.repeat(700000), () => {",
    "    fs.writeFileSync(process.argv[1], 'done');",
    '  });',
    '});',
  ].join('\n');

  const result = await execInGroup(process.execPath, ['-e', script, marker], {
    cwd: directory,
    onStarted: async () => undefined,
  });

  expect(result.code).toBe(0);
  expect(result.killed).toBe(false);
  expect(result.truncated).toBe(true);
  expect(result.stdout.length + result.stderr.length).toBe(1_048_576);
  expect(existsSync(marker)).toBe(true);
});

const createFakeChild = () => {
  const listeners = new Map<string, Set<(...argumentsList: unknown[]) => void>>();

  const addListener = (event: string, listener: (...argumentsList: unknown[]) => void) => {
    const registered = listeners.get(event) ?? new Set();
    registered.add(listener);
    listeners.set(event, registered);
  };

  const child = {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn<(signal?: NodeJS.Signals) => boolean>(),
    on: (event: string, listener: (...argumentsList: unknown[]) => void) => {
      addListener(event, listener);

      return child;
    },
    once: (event: string, listener: (...argumentsList: unknown[]) => void) => {
      const wrapper = (...argumentsList: unknown[]) => {
        listeners.get(event)?.delete(wrapper);
        listener(...argumentsList);
      };

      addListener(event, wrapper);

      return child;
    },
    emit: (event: string, ...argumentsList: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...argumentsList);
      }
    },
  };

  return child;
};

const startUnconfirmedRun = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const child = createFakeChild();

  spawnMock.mockReturnValueOnce(child as never);
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(promisify(execFile)).mockResolvedValue({ stdout: '4242 S\n', stderr: '' });

  const controller = new AbortController();

  const run = execInGroup('ignored', [], {
    cwd: '/repository',
    signal: controller.signal,
    onStarted: async () => {
      controller.abort();
    },
  });

  return { child, run };
};

it('waits for close even when the group does not stop after SIGKILL', async () => {
  const { child, run } = startUnconfirmedRun();
  let settled = false;

  const tracked = run.then((result) => {
    settled = true;

    return result;
  });

  await vi.advanceTimersByTimeAsync(7000);

  expect(settled).toBe(false);

  child.emit('close', 0);

  const result = await tracked;

  expect(result).toMatchObject({
    code: 0,
    killed: true,
    stdout: '',
    stderr: 'The command group did not stop within 2000 ms after SIGKILL.',
  });
});

it('records a child error and waits for close', async () => {
  const child = createFakeChild();
  spawnMock.mockReturnValueOnce(child as never);
  let settled = false;

  const run = execInGroup('ignored', [], {
    cwd: '/repository',
    onStarted: async () => undefined,
  }).then((result) => {
    settled = true;

    return result;
  });

  child.emit('error', new Error('spawn failed'));

  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

  expect(settled).toBe(false);

  child.emit('close', 1);

  const result = await run;

  expect(result).toMatchObject({ code: 1, stderr: 'spawn failed' });
});

it('starts the did-not-stop line on its own line when stderr already has text', async () => {
  const { child, run } = startUnconfirmedRun();

  child.stderr.write('boom');
  await vi.advanceTimersByTimeAsync(7000);
  child.emit('close', 1);

  const result = await run;

  expect(result.stderr).toBe('boom\nThe command group did not stop within 2000 ms after SIGKILL.');
});
