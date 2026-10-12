import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { hasErrorCode, isMissingFile } from '../../errors.js';
import { isRecord } from '../../isRecord.js';

interface LockOwner {
  pid: number;
  checkout: string;
  startedAt: string;
  token: string;
  released?: true;
}

export interface QueueOptions {
  lockPath: string;
  checkout: string;
  signal: AbortSignal | undefined;
  pollMilliseconds: number;
  // Called when another checkout holds the lock, once for each holder.
  onWaiting: (holder: LockOwner | undefined) => void;
  // Runs between reading the holder and linking the next generation. Tests use it to stall a session.
  beforeLink?: () => Promise<void>;
}

const tokenRadix = 36;

const parseOwner = (text: string): LockOwner | undefined => {
  try {
    const value: unknown = JSON.parse(text);

    if (!isRecord(value)) {
      return undefined;
    }

    const { pid, checkout, startedAt, token } = value;

    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) {
      return undefined;
    }

    if (typeof checkout !== 'string' || typeof startedAt !== 'string') {
      return undefined;
    }

    const released = value['released'] === true ? { released: true as const } : {};

    return { pid, checkout, startedAt, token: typeof token === 'string' ? token : '', ...released };
  } catch {
    return undefined;
  }
};

const readOwner = async (lockPath: string): Promise<LockOwner | undefined> => {
  try {
    return parseOwner(await readFile(lockPath, 'utf8'));
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return hasErrorCode(error, 'EPERM');
  }
};

const generationPath = (lockPath: string, generation: number): string =>
  `${lockPath}.${generation}`;

// Links a fully written file into place, so no reader ever sees a partly written lock.
const tryCreate = async (path: string, owner: LockOwner): Promise<boolean> => {
  const staging = `${path}.${owner.token}.staging`;

  await writeFile(staging, JSON.stringify(owner), { flag: 'wx' });

  try {
    await link(staging, path);

    return true;
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }

    throw error;
  } finally {
    await rm(staging, { force: true });
  }
};

const sleep = (milliseconds: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    const timer = setTimeout(finish, milliseconds);

    signal?.addEventListener('abort', finish, { once: true });
  });

const abortedError = (): Error => new Error('The full check was cancelled while it waited.');

const listGenerations = async (lockPath: string): Promise<number[]> => {
  const prefix = `${basename(lockPath)}.`;
  const names = await readdir(dirname(lockPath));

  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)))
    .toSorted((left, right) => left - right);
};

const holderIsGone = (holder: LockOwner | undefined): boolean =>
  holder === undefined || holder.released === true || !processIsAlive(holder.pid);

// The lock is the file of the highest generation. A new owner takes the next generation with an
// atomic link, so two sessions that both see a dead holder cannot both win, and no one ever
// removes the file of an owner that is still live. Files of older generations are garbage.
const removeOlderGenerations = async (lockPath: string, generation: number): Promise<void> => {
  const generations = await listGenerations(lockPath);
  const older = generations.filter((candidate) => candidate < generation);

  await Promise.all(
    older.map((candidate) => rm(generationPath(lockPath, candidate), { force: true })),
  );
};

// Marks the owner's own file as released. Only the owner rewrites a live file.
const releaseLock = async (path: string, owner: LockOwner): Promise<void> => {
  const current = await readOwner(path);

  if (current?.token !== owner.token) {
    return;
  }

  const staging = `${path}.${owner.token}.released`;

  await writeFile(staging, JSON.stringify({ ...owner, released: true }));
  await rename(staging, path);
};

const newToken = (): string =>
  `${process.pid}-${Date.now()}-${Math.random().toString(tokenRadix).slice(2)}`;

const findHolder = async (
  lockPath: string,
): Promise<{ highest: number | undefined; holder: LockOwner | undefined }> => {
  const generations = await listGenerations(lockPath);
  const highest = generations.at(-1);

  if (highest === undefined) {
    return { highest, holder: undefined };
  }

  return { highest, holder: await readOwner(generationPath(lockPath, highest)) };
};

// Links generation `next`, and keeps it only if no higher generation exists. A stalled session can
// link a number that was deleted while a higher generation is live.
const claimGeneration = async (
  options: QueueOptions,
  owner: LockOwner,
  next: number,
): Promise<boolean> => {
  const { lockPath } = options;
  const path = generationPath(lockPath, next);

  await options.beforeLink?.();

  if (!(await tryCreate(path, owner))) {
    return false;
  }

  const current = await listGenerations(lockPath);

  if (current.some((generation) => generation > next)) {
    await rm(path, { force: true });

    return false;
  }

  await removeOlderGenerations(lockPath, next);

  return true;
};

// Polls until this process owns the lock and returns the path of its file. Each poll depends on
// the one before, so the loop awaits.
const acquireLock = async (options: QueueOptions, owner: LockOwner): Promise<string> => {
  const { lockPath, signal, pollMilliseconds, onWaiting } = options;
  let reportedHolder: string | undefined;

  for (;;) {
    if (signal?.aborted === true) {
      throw abortedError();
    }

    // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
    const { highest, holder } = await findHolder(lockPath);

    if (highest === undefined || holderIsGone(holder)) {
      const next = (highest ?? 0) + 1;
      const path = generationPath(lockPath, next);

      // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
      if (await claimGeneration(options, owner, next)) {
        return path;
      }
    } else {
      const holderKey = `${holder?.pid}:${holder?.token}`;

      if (holderKey !== reportedHolder) {
        reportedHolder = holderKey;
        onWaiting(holder);
      }
    }

    // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
    await sleep(pollMilliseconds, signal);
  }
};

// Runs `run` while this process holds the machine-wide full check lock. Waits for another holder,
// takes over a lock whose process is gone, and releases the lock on every exit path.
export const withFullCheckLock = async <T>(
  options: QueueOptions,
  run: () => Promise<T>,
): Promise<T> => {
  const { lockPath, checkout } = options;
  const token = newToken();

  const owner: LockOwner = {
    pid: process.pid,
    checkout,
    startedAt: new Date().toISOString(),
    token,
  };

  await mkdir(dirname(lockPath), { recursive: true });
  const path = await acquireLock(options, owner);

  try {
    return await run();
  } finally {
    await releaseLock(path, owner);
  }
};

export const defaultLockPath = (agentDirectory: string): string =>
  join(agentDirectory, 'tau', 'full-check.lock');
