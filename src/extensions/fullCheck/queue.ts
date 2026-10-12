import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { hasErrorCode, isMissingFile } from '../../errors.js';
import { isRecord } from '../../isRecord.js';

interface LockOwner {
  pid: number;
  checkout: string;
  startedAt: string;
  token: string;
}

export interface QueueOptions {
  lockPath: string;
  checkout: string;
  signal: AbortSignal | undefined;
  pollMilliseconds: number;
  // Called when another checkout holds the lock, once for each holder.
  onWaiting: (holder: LockOwner | undefined) => void;
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

    return { pid, checkout, startedAt, token: typeof token === 'string' ? token : '' };
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

// Links a fully written file into place, so no reader ever sees a partly written lock.
const tryCreate = async (lockPath: string, owner: LockOwner): Promise<boolean> => {
  const staging = `${lockPath}.${owner.token}`;

  await writeFile(staging, JSON.stringify(owner), { flag: 'wx' });

  try {
    await link(staging, lockPath);

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

const takeOverIfDead = async (lockPath: string, holder: LockOwner): Promise<void> => {
  if (processIsAlive(holder.pid)) {
    return;
  }

  // Remove the lock only if the dead owner still holds it, not a new owner.
  const current = await readOwner(lockPath);

  if (current?.token === holder.token && current.pid === holder.pid) {
    await rm(lockPath, { force: true });
  }
};

const releaseLock = async (lockPath: string, token: string): Promise<void> => {
  const current = await readOwner(lockPath);

  if (current?.token === token) {
    await rm(lockPath, { force: true });
  }
};

const newToken = (): string =>
  `${process.pid}-${Date.now()}-${Math.random().toString(tokenRadix).slice(2)}`;

// Polls until this process owns the lock. Each poll depends on the one before, so the loop awaits.
const acquireLock = async (options: QueueOptions, owner: LockOwner): Promise<void> => {
  const { lockPath, signal, pollMilliseconds, onWaiting } = options;
  let reportedHolder: string | undefined;

  for (;;) {
    if (signal?.aborted === true) {
      throw abortedError();
    }

    // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
    if (await tryCreate(lockPath, owner)) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
    const holder = await readOwner(lockPath);
    const holderKey = holder === undefined ? '' : `${holder.pid}:${holder.token}`;

    if (holder !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
      await takeOverIfDead(lockPath, holder);
    }

    const holderIsAlive = holder === undefined || processIsAlive(holder.pid);
    const isNewHolder = holderKey !== reportedHolder;

    if (isNewHolder && holderIsAlive) {
      reportedHolder = holderKey;
      onWaiting(holder);
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
  await acquireLock(options, owner);

  try {
    return await run();
  } finally {
    await releaseLock(lockPath, token);
  }
};

export const defaultLockPath = (agentDirectory: string): string =>
  join(agentDirectory, 'tau', 'full-check.lock');
