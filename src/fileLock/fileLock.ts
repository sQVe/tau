import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { hasErrorCode, isMissingFile } from '../errors.js';
import { groupState, processState } from '../process/process.js';
import { isRecord } from '../schema.js';
import { holderIsGone } from './lockHolderDecision.js';
import type { LockHolderFacts } from './lockHolderDecision.js';

interface LockOwner {
  pid: number;
  checkout: string;
  startedAt: string;
  token: string;
  released?: true;
  // Process group of the running command, which outlives its session.
  commandGroup?: number;
}

export interface FileLockOptions {
  cancelled: () => Error;
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

const parseCommandGroup = (group: unknown): { commandGroup?: number } =>
  typeof group === 'number' && Number.isInteger(group) && group > 1 ? { commandGroup: group } : {};

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
    const commandGroup = parseCommandGroup(value['commandGroup']);

    return {
      pid,
      checkout,
      startedAt,
      token: typeof token === 'string' ? token : '',
      ...released,
      ...commandGroup,
    };
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

const waitForNextPoll = async (
  milliseconds: number,
  signal: AbortSignal | undefined,
  cancelled: () => Error,
): Promise<void> => {
  try {
    await sleep(milliseconds, undefined, { signal });
  } catch {
    throw cancelled();
  }
};

const listGenerations = async (lockPath: string): Promise<number[]> => {
  const prefix = `${basename(lockPath)}.`;
  const names = await readdir(dirname(lockPath));

  return names
    .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)))
    .toSorted((left, right) => left - right);
};

const readHolderFacts = async (holder: LockOwner | undefined): Promise<LockHolderFacts> => {
  const commandState =
    holder?.commandGroup === undefined ? 'gone' : await groupState(holder.commandGroup);

  return {
    recorded: holder !== undefined,
    released: holder?.released === true,
    sessionAlive: holder !== undefined && processState(holder.pid) !== 'gone',
    commandAlive: commandState !== 'gone',
  };
};

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

// Rewrites the owner's own file. Only the owner rewrites a live file.
const rewriteOwnFile = async (path: string, owner: LockOwner, next: LockOwner): Promise<void> => {
  const current = await readOwner(path);

  if (current?.token !== owner.token) {
    return;
  }

  const staging = `${path}.${owner.token}.rewrite`;

  await writeFile(staging, JSON.stringify(next));
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
  options: FileLockOptions,
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
const acquireLock = async (options: FileLockOptions, owner: LockOwner): Promise<string> => {
  const { lockPath, signal, pollMilliseconds, onWaiting, cancelled } = options;
  let reportedHolder: string | undefined;

  for (;;) {
    if (signal?.aborted === true) {
      throw cancelled();
    }

    // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
    const { highest, holder } = await findHolder(lockPath);

    // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
    const facts = await readHolderFacts(holder);

    if (highest === undefined || holderIsGone(facts)) {
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
    await waitForNextPoll(pollMilliseconds, signal, cancelled);
  }
};

export const withFileLock = async <T>(
  options: FileLockOptions,
  run: (recordCommandGroup: (groupId: number) => Promise<void>) => Promise<T>,
): Promise<T> => {
  const { lockPath, checkout, cancelled } = options;
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
    if (options.signal?.aborted === true) {
      throw cancelled();
    }

    return await run((groupId) => rewriteOwnFile(path, owner, { ...owner, commandGroup: groupId }));
  } finally {
    await rewriteOwnFile(path, owner, { ...owner, released: true });
  }
};
