import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { withFileLock } from './fileLock.js';
import { cancelled, fixture, heldLocks, ownerJson } from './fixtures/fileLockHarness.js';

const fileFaults = vi.hoisted(() => ({
  storageFull: false,
  truncateFails: false,
  afterOwnerRead: undefined as (() => Promise<void>) | undefined,
}));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  const faultyWriteFile: typeof original.writeFile = async (path, data, options) => {
    if (fileFaults.storageFull) {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }

    await original.writeFile(path, data, options);
  };

  const faultyTruncate: typeof original.truncate = async (path, length) => {
    if (fileFaults.truncateFails) {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    }

    await original.truncate(path, length);
  };

  // Runs the hook once, after a session reads an owner record and before it acts on the record.
  const pausingReadFile = (async (...readArguments: Parameters<typeof original.readFile>) => {
    const text = await original.readFile(...readArguments);
    const afterOwnerRead = fileFaults.afterOwnerRead;

    fileFaults.afterOwnerRead = undefined;
    await afterOwnerRead?.();

    return text;
  }) as typeof original.readFile;

  const faults = {
    writeFile: faultyWriteFile,
    truncate: faultyTruncate,
    readFile: pausingReadFile,
  };

  return { ...original, ...faults, default: { ...original, ...faults } };
});

const clearFileFaults = () => {
  fileFaults.storageFull = false;
  fileFaults.truncateFails = false;
};

it('releases the lock when storage refuses new files, so the next caller acquires it without waiting', async () => {
  const { lockPath } = fixture();

  onTestFinished(clearFileFaults);

  const options = {
    lockPath,
    checkout: '/holder',
    signal: undefined,
    pollMilliseconds: 60_000,
    cancelled,
    onWaiting: () => undefined,
  };

  const result = await withFileLock(options, async () => {
    fileFaults.storageFull = true;

    return 'ran';
  });

  clearFileFaults();

  const controller = new AbortController();
  const waitedFor: unknown[] = [];

  const next = await withFileLock(
    {
      ...options,
      checkout: '/next',
      signal: controller.signal,
      onWaiting: (holder) => {
        waitedFor.push(holder);
        controller.abort();
      },
    },
    async () => 'next ran',
  );

  expect(result).toBe('ran');
  expect(next).toBe('next ran');
  expect(waitedFor).toEqual([]);
  expect(await heldLocks(lockPath)).toEqual([]);
});

it.each([
  { name: 'replaced by another owner', replacement: ownerJson('other') },
  { name: 'removed', replacement: undefined },
])('leaves a lock file $name alone when storage refuses the release', async ({ replacement }) => {
  const { lockPath } = fixture();
  const heldPath = `${lockPath}.1`;

  onTestFinished(clearFileFaults);

  const result = await withFileLock(
    {
      lockPath,
      checkout: '/holder',
      signal: undefined,
      pollMilliseconds: 60_000,
      cancelled,
      onWaiting: () => undefined,
    },
    async () => {
      await (replacement === undefined ? rm(heldPath) : writeFile(heldPath, replacement));
      fileFaults.storageFull = true;

      return 'ran';
    },
  );

  const text = await readFile(heldPath, 'utf8').catch(() => undefined);

  expect(result).toBe('ran');
  expect(text).toBe(replacement);
});

it('rejects with the error of the run when the release fails too', async () => {
  const { lockPath } = fixture();

  onTestFinished(clearFileFaults);

  const outcome = withFileLock(
    {
      lockPath,
      checkout: '/holder',
      signal: undefined,
      pollMilliseconds: 60_000,
      cancelled,
      onWaiting: () => undefined,
    },
    async () => {
      fileFaults.storageFull = true;
      fileFaults.truncateFails = true;

      throw new Error('The run failed.');
    },
  );

  await expect(outcome).rejects.toThrow('The run failed.');
});

it('keeps the lock when its session records a command and dies after another session read the record', async () => {
  const { lockPath } = fixture();
  const session = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });

  await new Promise((resolve) => {
    session.once('close', resolve);
  });

  const command = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: true,
  });

  onTestFinished(() => {
    command.kill('SIGKILL');
  });

  const heldPath = `${lockPath}.1`;

  const owner = {
    pid: session.pid,
    checkout: '/gone',
    startedAt: new Date().toISOString(),
    token: 'dead-session',
  };

  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(heldPath, JSON.stringify(owner));

  fileFaults.afterOwnerRead = async () => {
    await writeFile(heldPath, JSON.stringify({ ...owner, commandGroup: command.pid }));
  };

  onTestFinished(() => {
    fileFaults.afterOwnerRead = undefined;
  });

  const run = vi.fn<() => Promise<undefined>>(async () => undefined);

  const outcome = withFileLock(
    {
      lockPath,
      checkout: '/second',
      signal: undefined,
      pollMilliseconds: 10,
      cancelled,
      onWaiting: () => {
        throw new Error('Another session holds the lock.');
      },
    },
    run,
  );

  await expect(outcome).rejects.toThrow('Another session holds the lock.');
  expect(run).not.toHaveBeenCalled();
});
