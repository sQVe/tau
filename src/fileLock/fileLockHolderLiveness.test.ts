import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { withFileLock } from './fileLock.js';
import { cancelled, fixture } from './fixtures/fileLockHarness.js';

it.each([
  {
    name: 'an unreadable command group',
    sessionError: 'ESRCH',
    commandGroup: 202,
  },
  {
    name: 'an unknown session process',
    sessionError: 'EINVAL',
    commandGroup: undefined,
  },
])(
  'keeps the lock for $name and cancels without changing it',
  async ({ sessionError, commandGroup }) => {
    const { lockPath, directory } = fixture();
    const heldPath = `${lockPath}.1`;

    const owner = JSON.stringify({
      pid: 101,
      checkout: '/gone',
      startedAt: new Date().toISOString(),
      token: 'dead-session',
      commandGroup,
    });

    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(heldPath, owner);

    vi.spyOn(process, 'kill').mockImplementation((processId) => {
      if (processId === 101) {
        throw Object.assign(new Error('Session probe failed'), { code: sessionError });
      }

      return true;
    });

    vi.stubEnv('PATH', directory);

    onTestFinished(() => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });

    const waiting = Promise.withResolvers<undefined>();
    const controller = new AbortController();
    const run = vi.fn<() => Promise<undefined>>(async () => undefined);

    onTestFinished(() => {
      controller.abort();
    });

    const outcome = withFileLock(
      {
        lockPath,
        checkout: '/queued',
        signal: controller.signal,
        pollMilliseconds: 60_000,
        cancelled,
        onWaiting: () => {
          waiting.resolve(undefined);
        },
      },
      run,
    );

    outcome.catch(() => undefined);

    await waiting.promise;
    controller.abort();
    await expect(outcome).rejects.toThrow('cancelled while it waited');

    expect(run).not.toHaveBeenCalled();
    expect(await readFile(heldPath, 'utf8')).toBe(owner);
    expect(await readdir(dirname(lockPath))).toEqual([basename(heldPath)]);
  },
);

it('keeps a dead session lock for a permission-denied command absent from ps on cancellation', async () => {
  const { lockPath, directory } = fixture();
  const session = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });

  await new Promise((resolve) => {
    session.once('close', resolve);
  });

  const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: true,
  });

  const closed = new Promise((resolve) => {
    command.once('close', resolve);
  });

  const groupId = command.pid ?? 0;
  const kernelKill = process.kill.bind(process);

  onTestFinished(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    command.kill('SIGKILL');
    await closed;
  });

  expect(groupId).toBeGreaterThan(0);
  expect(kernelKill(-groupId, 0)).toBe(true);

  const heldPath = `${lockPath}.1`;

  const owner = JSON.stringify({
    pid: session.pid,
    checkout: '/gone',
    startedAt: new Date().toISOString(),
    token: 'dead-session',
    commandGroup: groupId,
  });

  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(heldPath, owner);
  await writeFile(join(directory, 'ps'), '#!/bin/sh\nprintf "1 S\\n"\n', { mode: 0o755 });
  vi.stubEnv('PATH', directory);

  vi.spyOn(process, 'kill').mockImplementation((processId, signal) => {
    if (processId === -groupId && signal === 0) {
      throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
    }

    return kernelKill(processId, signal);
  });

  const controller = new AbortController();
  const run = vi.fn<() => Promise<undefined>>(async () => undefined);

  const outcome = withFileLock(
    {
      lockPath,
      checkout: '/queued',
      signal: controller.signal,
      pollMilliseconds: 60_000,
      cancelled,
      onWaiting: () => {
        controller.abort();
      },
    },
    run,
  );

  await expect(outcome).rejects.toThrow('cancelled while it waited');

  expect(run).not.toHaveBeenCalled();
  expect(kernelKill(-groupId, 0)).toBe(true);
  expect(await readFile(heldPath, 'utf8')).toBe(owner);
  expect(await readdir(dirname(lockPath))).toEqual([basename(heldPath)]);
});

it('takes over a lock whose command group holds only zombies', async () => {
  const { lockPath } = fixture();

  const session = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = session.pid ?? 0;

  await new Promise((resolve) => {
    session.once('close', resolve);
  });

  const parent = spawn(
    'python3',
    [
      '-c',
      'import os, sys\n' +
        'pid = os.fork()\n' +
        'if pid == 0:\n' +
        '    os.setsid()\n' +
        '    os._exit(0)\n' +
        'os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)\n' +
        'print(pid, flush=True)\n' +
        'sys.stdin.read()\n' +
        'os.waitpid(pid, 0)\n',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const closed = new Promise<number | null>((resolve) => {
    parent.once('close', resolve);
  });

  onTestFinished(async () => {
    parent.stdin.end();

    expect(await closed).toBe(0);
  });

  const zombieGroup = await new Promise<number>((resolve, reject) => {
    parent.once('error', reject);

    parent.stdout.once('data', (data: Buffer) => {
      resolve(Number(data.toString().trim()));
    });
  });

  const { stdout } = await promisify(execFile)('ps', ['-A', '-o', 'pgid=,stat=']);

  const groupStates = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/u))
    .filter(([group]) => Number(group) === zombieGroup)
    .map(([, state]) => state);

  expect(groupStates).toHaveLength(1);
  expect(groupStates[0]).toMatch(/^Z/u);
  expect(parent.exitCode).toBeNull();

  await mkdir(dirname(lockPath), { recursive: true });

  await writeFile(
    `${lockPath}.1`,
    JSON.stringify({
      pid: deadPid,
      checkout: '/gone',
      startedAt: new Date().toISOString(),
      token: 'dead',
      commandGroup: zombieGroup,
    }),
  );

  const options = {
    lockPath,
    checkout: '/here',
    signal: AbortSignal.timeout(2000),
    pollMilliseconds: 20,
    cancelled,
    onWaiting: () => undefined,
  };

  const ran = await withFileLock(options, () => Promise.resolve('ran'));

  expect(ran).toBe('ran');
  expect(parent.exitCode).toBeNull();
});
