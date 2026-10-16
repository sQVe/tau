import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { onTestFinished, expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { commandIsAlive } from './queue.js';
import { runCheck } from './run.js';

vi.mock(import('node:child_process'), async (importOriginal) => {
  const original = await importOriginal();

  const spawnRecorded = vi.fn<
    (command: string, commandArguments: readonly string[], options: SpawnOptions) => ChildProcess
  >((command, commandArguments, options) => original.spawn(command, commandArguments, options));

  return { ...original, spawn: spawnRecorded as unknown as typeof original.spawn };
});

const waitForGroupExit = async (groupId: number): Promise<void> => {
  while (commandIsAlive(groupId)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

it('returns only after the command group is recorded, even when the command exits first', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  let recorded = false;

  const result = await runCheck(root, [process.execPath, '-e', ''], undefined, async (groupId) => {
    await waitForGroupExit(groupId);

    // Leaves time for a run that does not wait for the record to return first.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    recorded = true;
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

  const outcome = runCheck(root, ['tau-no-such-command'], controller.signal, async () => {});

  await expect(outcome).rejects.toThrow('ENOENT');

  // The close event follows the error event.
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  expect(killed.filter(([processId]) => processId === 0)).toEqual([]);
});

it('stops the direct child and probes it by pid on win32, without a process group', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  const killed: unknown[][] = [];
  const realKill = process.kill.bind(process);

  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

  vi.spyOn(process, 'kill').mockImplementation((...killArguments) => {
    killed.push(killArguments);

    return realKill(...killArguments);
  });

  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  const controller = new AbortController();

  const outcome = runCheck(
    root,
    [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    controller.signal,
    async () => {
      controller.abort();
    },
  );

  await expect(outcome).rejects.toThrow('its command has stopped');

  const options = vi.mocked(spawn).mock.lastCall?.[2];

  expect(options).toMatchObject({ detached: false });

  expect(killed.filter(([processId]) => typeof processId === 'number' && processId < 0)).toEqual(
    [],
  );

  expect(
    killed.some(
      ([processId, signal]) => typeof processId === 'number' && processId > 0 && signal === 0,
    ),
  ).toBe(true);
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

  const result = await runCheck(root, [process.execPath, '-e', script], undefined, async () => {});
  const backgroundPid = Number(await readFile(pidFile, 'utf8'));

  expect(result).toMatchObject({ passed: true, exitCode: 0 });
  expect(processIsAlive(backgroundPid)).toBe(false);
});

it('stops a command that prints once and then goes silent, and reports the hang', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  const script = "console.log('summary'); setInterval(() => {}, 1000)";
  const started = Date.now();

  const result = await runCheck(
    root,
    [process.execPath, '-e', script],
    undefined,
    async () => {},
    300,
  );

  expect(result).toMatchObject({ passed: false, idle: true });
  expect(result.tail).toContain('summary');
  expect(Date.now() - started).toBeLessThan(4000);
});

it('does not stop a command that keeps writing output', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');

  const script =
    "let count = 0; const timer = setInterval(() => { console.log('tick'); if (++count === 12) { clearInterval(timer); } }, 50)";

  const result = await runCheck(
    root,
    [process.execPath, '-e', script],
    undefined,
    async () => {},
    400,
  );

  expect(result).toMatchObject({ passed: true, idle: false });
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

  const result = await runCheck(
    root,
    [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    undefined,
    async () => {},
    300,
  );

  signalled.length = 0;
  vi.advanceTimersByTime(60_000);

  expect(result.idle).toBe(true);
  expect(signalled).toEqual([]);
});
