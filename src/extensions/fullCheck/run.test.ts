import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { onTestFinished, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { groupState } from '../../process/process.js';
import { defaultIdleLimitMilliseconds, runCheck } from './run.js';

// The stop grace is the only wall clock in a stop, so the tests bound it well inside the test budget.
const testStopGraceMilliseconds = 500;

const waitForGroupExit = async (groupId: number): Promise<void> => {
  while ((await groupState(groupId)) !== 'gone') {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

it('returns only after the command group is recorded, even when the command exits first', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  let recorded = false;

  const result = await runCheck({
    root,
    argv: [process.execPath, '-e', ''],
    signal: undefined,
    onStarted: async (groupId) => {
      await waitForGroupExit(groupId);

      // Leaves time for a run that does not wait for the record to return first.
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });

      recorded = true;
    },
    idleLimitMilliseconds: defaultIdleLimitMilliseconds,
    stopGraceMilliseconds: testStopGraceMilliseconds,
    output: 'combined',
  });

  expect(result.passed).toBe(true);
  expect(recorded).toBe(true);
});

it('settles a cancelled run of a command that cannot spawn without signalling process group zero', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  const killed: unknown[][] = [];

  vi.spyOn(process, 'kill').mockImplementation((...killArguments) => {
    killed.push(killArguments);

    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });

  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  const controller = new AbortController();

  controller.abort();

  const outcome = runCheck({
    root,
    argv: ['tau-no-such-command'],
    signal: controller.signal,
    onStarted: async () => {},
    idleLimitMilliseconds: defaultIdleLimitMilliseconds,
    stopGraceMilliseconds: testStopGraceMilliseconds,
    output: 'combined',
  });

  await expect(outcome).rejects.toThrow('ENOENT');

  // The close event follows the error event.
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  expect(killed.filter(([processId]) => processId === 0)).toEqual([]);
});

const processIsAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);

    return true;
  } catch {
    return false;
  }
};

it('returns only after a background process in the command group has gone', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  const pidFile = join(root, 'background.pid');

  const script = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    child.unref();
  `;

  const result = await runCheck({
    root,
    argv: [process.execPath, '-e', script],
    signal: undefined,
    onStarted: async () => {},
    idleLimitMilliseconds: defaultIdleLimitMilliseconds,
    stopGraceMilliseconds: testStopGraceMilliseconds,
    output: 'combined',
  });

  const backgroundPid = Number(await readFile(pidFile, 'utf8'));

  expect(result).toMatchObject({ passed: true, exitCode: 0 });
  expect(processIsAlive(backgroundPid)).toBe(false);
});

it('stops a command that prints once and then goes silent, and reports the hang', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  const script = "console.log('summary'); setInterval(() => {}, 1000)";
  const started = Date.now();

  const result = await runCheck({
    root,
    argv: [process.execPath, '-e', script],
    signal: undefined,
    onStarted: async () => {},
    idleLimitMilliseconds: 300,
    stopGraceMilliseconds: testStopGraceMilliseconds,
    output: 'combined',
  });

  expect(result).toMatchObject({ passed: false, idle: true });
  expect(result.tail).toContain('summary');
  expect(Date.now() - started).toBeLessThan(4000);
});

it('does not stop a command that keeps writing output', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');

  const script =
    "let count = 0; const timer = setInterval(() => { console.log('tick'); if (++count === 12) { clearInterval(timer); } }, 50)";

  const result = await runCheck({
    root,
    argv: [process.execPath, '-e', script],
    signal: undefined,
    onStarted: async () => {},
    idleLimitMilliseconds: 400,
    stopGraceMilliseconds: testStopGraceMilliseconds,
    output: 'combined',
  });

  expect(result).toMatchObject({ passed: true, idle: false });
});

it('keeps separately captured stdout parseable and stderr in the command log', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');

  const script =
    'process.stdout.write(JSON.stringify({ status: "ok" })); process.stderr.write("diagnostic\\n");';

  const result = await runCheck({
    root,
    argv: [process.execPath, '-e', script],
    signal: undefined,
    onStarted: async () => {},
    idleLimitMilliseconds: 4000,
    stopGraceMilliseconds: testStopGraceMilliseconds,
    output: 'report',
  });

  const stdout: unknown = JSON.parse(await readFile(result.stdoutPath ?? '', 'utf8'));

  expect(result).toMatchObject({ passed: true, idle: false, tail: 'diagnostic' });
  expect(stdout).toEqual({ status: 'ok' });
  expect(await readFile(result.logPath, 'utf8')).toBe('diagnostic\n');
});

// A command that ignores SIGTERM needs the escalation, which is the one wall clock in a stop.
it('stops a command that ignores SIGTERM within the stop grace it is given', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  const started = Date.now();
  let groupId = 0;

  const result = await runCheck({
    root,
    argv: [process.execPath, '-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    signal: undefined,
    onStarted: async (startedGroupId) => {
      groupId = startedGroupId;

      onTestFinished(() => {
        try {
          process.kill(-startedGroupId, 'SIGKILL');
        } catch {
          // The group has already stopped.
        }
      });
    },
    idleLimitMilliseconds: 300,
    stopGraceMilliseconds: 300,
    output: 'combined',
  });

  expect(result).toMatchObject({ passed: false, idle: true });
  expect(await groupState(groupId)).toBe('gone');

  // The 300 ms grace ends the stop, not the 5 s default.
  expect(Date.now() - started).toBeLessThan(3000);
});

it('refuses a stop grace that is not a positive safe integer', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');

  const cases = [
    { stopGraceMilliseconds: 0, message: 'got 0.' },
    { stopGraceMilliseconds: -1, message: 'got -1.' },
    { stopGraceMilliseconds: Number.NaN, message: 'got NaN.' },
    { stopGraceMilliseconds: 1.5, message: 'got 1.5.' },
  ];

  for (const { stopGraceMilliseconds, message } of cases) {
    const outcome = runCheck({
      root,
      argv: [process.execPath, '-e', ''],
      signal: undefined,
      onStarted: async () => {},
      idleLimitMilliseconds: 300,
      stopGraceMilliseconds,
      output: 'combined',
    });

    await expect(outcome).rejects.toThrow(message);
  }
});

it('sends no signal to the group after an idle stop returns', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  const realKill = process.kill.bind(process);
  const signalled: unknown[][] = [];

  vi.spyOn(process, 'kill').mockImplementation((...killArguments) => {
    signalled.push(killArguments);

    return realKill(...killArguments);
  });

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  onTestFinished(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const result = await runCheck({
    root,
    argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    signal: undefined,
    onStarted: async () => {},
    idleLimitMilliseconds: 300,
    stopGraceMilliseconds: testStopGraceMilliseconds,
    output: 'combined',
  });

  signalled.length = 0;
  vi.advanceTimersByTime(60_000);

  expect(result.idle).toBe(true);
  expect(signalled).toEqual([]);
});
