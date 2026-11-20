import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { withFileLock } from './fileLock.js';
import { cancelled, fixture, heldLocks, ownerJson } from './fixtures/fileLockHarness.js';

const fileFaults = vi.hoisted(() => ({
  storageFull: false,
  truncateFails: false,
  removeFault: undefined as { suffix: string; error: Error } | undefined,
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

  const faultyRemove: typeof original.rm = async (path, options) => {
    const fault = fileFaults.removeFault;

    if (fault !== undefined && String(path).endsWith(fault.suffix)) {
      fileFaults.removeFault = undefined;

      throw fault.error;
    }

    await original.rm(path, options);
  };

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
    rm: faultyRemove,
    readFile: pausingReadFile,
  };

  return { ...original, ...faults, default: { ...original, ...faults } };
});

const clearFileFaults = () => {
  fileFaults.storageFull = false;
  fileFaults.truncateFails = false;
  fileFaults.removeFault = undefined;
};

const failRemoveOnce = (suffix: string): Error => {
  const error = Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });

  fileFaults.removeFault = { suffix, error };

  return error;
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

it('releases a new claim when staging file removal fails', async () => {
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

  const acquisitionError = failRemoveOnce('.staging');

  const run = vi.fn<() => Promise<string>>(async () => 'ran');
  const outcome = withFileLock(options, run);

  await expect(outcome).rejects.toBe(acquisitionError);
  expect(run).not.toHaveBeenCalled();

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

  expect(next).toBe('next ran');
  expect(waitedFor).toEqual([]);
  expect(await heldLocks(lockPath)).toEqual([]);
});

it('releases a new claim when older generation cleanup fails', async () => {
  const { lockPath } = fixture();
  const olderPath = `${lockPath}.1`;

  onTestFinished(clearFileFaults);

  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(olderPath, ownerJson('older', true));

  const options = {
    lockPath,
    checkout: '/holder',
    signal: undefined,
    pollMilliseconds: 60_000,
    cancelled,
    onWaiting: () => undefined,
  };

  const acquisitionError = failRemoveOnce(olderPath);

  const run = vi.fn<() => Promise<string>>(async () => 'ran');
  const outcome = withFileLock(options, run);

  await expect(outcome).rejects.toBe(acquisitionError);
  expect(run).not.toHaveBeenCalled();

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

  expect(next).toBe('next ran');
  expect(waitedFor).toEqual([]);
  expect(await heldLocks(lockPath)).toEqual([]);
});

it('reports the claim error and the release error when the release fails too', async () => {
  const { lockPath } = fixture();

  onTestFinished(clearFileFaults);

  const acquisitionError = failRemoveOnce('.staging');
  const run = vi.fn<() => Promise<string>>(async () => 'ran');

  const outcome = withFileLock(
    {
      lockPath,
      checkout: '/holder',
      signal: undefined,
      pollMilliseconds: 60_000,
      cancelled,
      onWaiting: () => undefined,
      beforeLink: async () => {
        fileFaults.afterOwnerRead = async () => {
          throw new Error('The release read failed.');
        };
      },
    },
    run,
  );

  const thrown: unknown = await outcome.catch((error: unknown) => error);
  const failure = thrown as Error;

  expect(failure.message).toBe(
    'The claim failed: EIO: i/o error; releasing it failed: The release read failed.',
  );

  expect(failure.cause).toBe(acquisitionError);
  expect(run).not.toHaveBeenCalled();
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
