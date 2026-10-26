import { execFile, spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { withFileLock } from './fileLock.js';

const fixture = () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-file-lock-');

  return { directory, lockPath: join(directory, 'locks', 'cache.lock') };
};

const cancelled = () => new Error('The operation was cancelled while it waited.');

const heldLocks = async (lockPath: string) => {
  const directory = dirname(lockPath);
  const names = await readdir(directory).catch(() => []);
  const held: string[] = [];

  for (const name of names.filter((entry) => /\.\d+$/u.test(entry))) {
    const owner = JSON.parse(await readFile(join(directory, name), 'utf8')) as {
      released?: boolean;
    };

    if (owner.released !== true) {
      held.push(name);
    }
  }

  return held;
};

const ownerJson = (token: string, released = false) =>
  JSON.stringify({
    pid: process.pid,
    checkout: '/other',
    startedAt: new Date().toISOString(),
    token,
    ...(released ? { released: true } : {}),
  });

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

it('cancels a queued waiter without running it or changing the held lock', async () => {
  const { lockPath } = fixture();
  const held = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  const options = {
    lockPath,
    checkout: '/holder',
    signal: undefined,
    pollMilliseconds: 60_000,
    cancelled,
    onWaiting: () => undefined,
  };

  const holder = withFileLock(options, () => {
    held.resolve(undefined);

    return release.promise;
  });

  await held.promise;
  const original = await readFile(`${lockPath}.1`, 'utf8');
  const waiting = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const run = vi.fn<() => Promise<undefined>>(async () => undefined);

  const waiter = withFileLock(
    {
      ...options,
      signal: controller.signal,
      onWaiting: () => {
        waiting.resolve(undefined);
      },
    },
    run,
  );

  waiter.catch(() => undefined);

  try {
    await waiting.promise;
    controller.abort();
    await expect(waiter).rejects.toThrow('cancelled while it waited');

    expect(run).not.toHaveBeenCalled();
    expect(await readFile(`${lockPath}.1`, 'utf8')).toBe(original);
    expect(await heldLocks(lockPath)).toHaveLength(1);
    expect(await readdir(dirname(lockPath))).toHaveLength(1);
  } finally {
    controller.abort();
    release.resolve(undefined);
    await holder;
  }
});

it('releases a queued caller cancelled during acquisition without dispatching it', async () => {
  const { lockPath } = fixture();
  const held = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const waiting = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const run = vi.fn<() => Promise<string>>(async () => 'cancelled callback ran');
  let previousOwner: unknown;

  const options = {
    lockPath,
    checkout: '/holder',
    signal: undefined,
    pollMilliseconds: 10,
    cancelled,
    onWaiting: () => undefined,
  };

  const holder = withFileLock(options, () => {
    held.resolve(undefined);

    return release.promise;
  });

  await held.promise;

  const waiter = withFileLock(
    {
      ...options,
      checkout: '/waiter',
      signal: controller.signal,
      onWaiting: () => {
        waiting.resolve(undefined);
      },
      beforeLink: async () => {
        previousOwner = JSON.parse(await readFile(`${lockPath}.1`, 'utf8'));
        controller.abort();
      },
    },
    run,
  );

  waiter.catch(() => undefined);

  try {
    await waiting.promise;
    release.resolve(undefined);
    await holder;
    await expect(waiter).rejects.toThrow('cancelled while it waited');

    expect(run).not.toHaveBeenCalled();
    expect(previousOwner).toMatchObject({ checkout: '/holder', released: true });

    const cancelledOwner: unknown = JSON.parse(await readFile(`${lockPath}.2`, 'utf8'));

    expect(cancelledOwner).toMatchObject({ checkout: '/waiter', released: true });
    expect(await heldLocks(lockPath)).toEqual([]);

    const next = await withFileLock({ ...options, checkout: '/next' }, async () => 'ran');

    expect(next).toBe('ran');
    expect(await heldLocks(lockPath)).toEqual([]);
  } finally {
    controller.abort();
    release.resolve(undefined);
    await Promise.allSettled([holder, waiter]);
  }
});

it('does not run while a higher generation is live after linking a lower one', async () => {
  const { lockPath } = fixture();
  const live = `${lockPath}.3`;

  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(`${lockPath}.1`, ownerJson('first', true));

  let stalled = false;
  let ranWhileLive = false;

  await withFileLock(
    {
      lockPath,
      checkout: '/stalled',
      signal: undefined,
      pollMilliseconds: 10,
      cancelled,
      onWaiting: () => {
        writeFile(live, ownerJson('third', true)).catch(() => undefined);
      },
      beforeLink: async () => {
        if (stalled) {
          return;
        }

        stalled = true;
        await writeFile(live, ownerJson('third'));
        await rm(`${lockPath}.1`);
      },
    },
    async () => {
      const text = await readFile(live, 'utf8').catch(() => undefined);

      // A removed file means the higher holder released and was replaced.
      ranWhileLive = text !== undefined && !text.includes('"released":true');
    },
  );

  expect(ranWhileLive).toBe(false);
  expect(await heldLocks(lockPath)).toEqual([]);
});

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

it('retries when another caller links the same first generation', async () => {
  const { lockPath } = fixture();
  const bothArrived = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const contended = Promise.withResolvers<undefined>();
  let arrived = 0;
  let active = 0;
  let maxActive = 0;
  let maxHeld = 0;
  let waitingCount = 0;

  const options = {
    lockPath,
    checkout: '/racer',
    signal: undefined,
    pollMilliseconds: 10,
    cancelled,
    onWaiting: () => {
      waitingCount += 1;
      contended.resolve(undefined);
    },
    beforeLink: async () => {
      arrived += 1;

      if (arrived === 2) {
        bothArrived.resolve(undefined);
      }

      await release.promise;
    },
  };

  const run = vi.fn<() => Promise<string>>(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);

    if (active > 1) {
      contended.resolve(undefined);
    }

    const held = await heldLocks(lockPath);
    maxHeld = Math.max(maxHeld, held.length);

    await contended.promise;
    active -= 1;

    return 'ran';
  });

  const first = withFileLock(options, run);
  const second = withFileLock({ ...options, checkout: '/other-racer' }, run);
  const outcomes = Promise.all([first, second]);

  outcomes.catch(() => {
    contended.resolve(undefined);
  });

  await bothArrived.promise;
  release.resolve(undefined);

  expect(await outcomes).toEqual(['ran', 'ran']);
  expect(run).toHaveBeenCalledTimes(2);
  expect(maxActive).toBe(1);
  expect(maxHeld).toBe(1);
  expect(waitingCount).toBeGreaterThan(0);
  expect(await heldLocks(lockPath)).toEqual([]);
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
