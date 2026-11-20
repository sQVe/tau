import { link, mkdir, readdir, readFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { errorMessage, hasErrorCode, isMissingFile } from '../errors.js';
import { groupState, processState } from '../process/process.js';
import { isRecord } from '../schema.js';
import { holderIsGone, recordNeedsRereading } from './lockHolderDecision.js';
import type { LockHolderFacts } from './lockHolderDecision.js';

export interface LiveLockHolder {
  pid: number;
  checkout: string;
  terminal: string | undefined;
  startedAt: string;
  token: string;
}

interface LockOwner {
  pid: number;
  checkout: string;
  startedAt: string;
  token: string;
  released?: true;
  // Process group of the running command, which outlives its session.
  commandGroup?: number;
  terminal?: string;
}

export interface FileLockOptions {
  cancelled: () => Error;
  lockPath: string;
  checkout: string;
  terminal?: string;
  signal: AbortSignal | undefined;
  pollMilliseconds: number;
  // Called when another checkout holds the lock, once for each holder.
  onWaiting: (holder: LockOwner | undefined) => void;
  // Runs between reading the holder and linking the next generation. Tests use it to stall a session.
  beforeLink?: () => Promise<void>;
  token?: string;
}

export interface HoldFileLockOptions {
  lockPath: string;
  checkout: string;
  terminal: string | undefined;
  // Names the owner in the lock file. Without it, the lock makes a token.
  token?: string;
}

export type HeldFileLock =
  | { kind: 'held'; release: () => Promise<void> }
  | { kind: 'refused'; holder: LiveLockHolder | undefined };

type LockClaim = Omit<LockOwner, 'startedAt'>;

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
    const terminal = value['terminal'];

    return {
      pid,
      checkout,
      startedAt,
      token: typeof token === 'string' ? token : '',
      ...released,
      ...commandGroup,
      ...(typeof terminal === 'string' && terminal !== '' ? { terminal } : {}),
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

const stagingPath = (path: string, owner: LockOwner): string => `${path}.${owner.token}.staging`;

// Links a fully written file into place, so no reader ever sees a partly written lock. A successful
// link leaves its staging file for the caller, which releases the claim if removing it fails.
const tryCreate = async (path: string, owner: LockOwner): Promise<boolean> => {
  const staging = stagingPath(path, owner);

  await writeFile(staging, JSON.stringify(owner), { flag: 'wx' });

  try {
    await link(staging, path);

    return true;
  } catch (error) {
    await rm(staging, { force: true });

    if (hasErrorCode(error, 'EEXIST')) {
      return false;
    }

    throw error;
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

const ownsFile = async (path: string, owner: LockOwner): Promise<boolean> => {
  const current = await readOwner(path);

  return current?.token === owner.token;
};

const replaceFile = async (path: string, owner: LockOwner, next: LockOwner): Promise<void> => {
  const staging = `${path}.${owner.token}.rewrite`;

  await writeFile(staging, JSON.stringify(next));
  await rename(staging, path);
};

const rewriteOwnFile = async (path: string, owner: LockOwner, next: LockOwner): Promise<void> => {
  if (await ownsFile(path, owner)) {
    await replaceFile(path, owner, next);
  }
};

// Releases the owner's file. When storage refuses the new file that a rewrite needs, empties the
// file in place instead. An empty file reads as a holder that left no record, and it keeps its
// generation, so the highest generation never goes down.
const releaseOwnFile = async (path: string, owner: LockOwner): Promise<void> => {
  if (!(await ownsFile(path, owner))) {
    return;
  }

  try {
    await replaceFile(path, owner, { ...owner, released: true });
  } catch {
    await truncate(path, 0);
  }
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

// Reads the holder's record again after its session is seen dead, so a command that the session
// recorded after the first read keeps the lock.
const findCurrentHolder = async (lockPath: string) => {
  const { highest, holder } = await findHolder(lockPath);
  const facts = await readHolderFacts(holder);

  if (highest === undefined || !recordNeedsRereading(facts)) {
    return { highest, holder, facts };
  }

  const current = await readOwner(generationPath(lockPath, highest));

  return { highest, holder: current, facts: await readHolderFacts(current) };
};

const toLiveHolder = (owner: LockOwner): LiveLockHolder => ({
  pid: owner.pid,
  checkout: owner.checkout,
  terminal: owner.terminal,
  startedAt: owner.startedAt,
  token: owner.token,
});

// Returns the holder only while its session or command is alive. A released, missing, or dead
// holder is not a live holder.
export const readLiveLockHolder = async (lockPath: string): Promise<LiveLockHolder | undefined> => {
  const current = await findCurrentHolder(lockPath).catch((error: unknown) => {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  });

  if (current === undefined) {
    return undefined;
  }

  const { holder, facts } = current;

  if (holder === undefined || holderIsGone(facts)) {
    return undefined;
  }

  return toLiveHolder(holder);
};

// Links generation `next`, and keeps it only if no higher generation exists. A stalled session can
// link a number that was deleted while a higher generation is live. The owner's start time is
// stamped here, after the attempt saw the old holder gone, so a lock is never older than anything
// its previous holder wrote while it held the lock. A tie in one millisecond is possible.
const claimGeneration = async (
  options: FileLockOptions,
  claim: LockClaim,
  next: number,
): Promise<LockOwner | undefined> => {
  const { lockPath } = options;
  const path = generationPath(lockPath, next);

  await options.beforeLink?.();

  const owner: LockOwner = { ...claim, startedAt: new Date().toISOString() };

  if (!(await tryCreate(path, owner))) {
    return undefined;
  }

  try {
    await rm(stagingPath(path, owner), { force: true });

    const current = await listGenerations(lockPath);

    if (current.some((generation) => generation > next)) {
      await rm(path, { force: true });

      return undefined;
    }

    await removeOlderGenerations(lockPath, next);
  } catch (claimError) {
    const releaseError = await releaseOwnFile(path, owner).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (releaseError === undefined) {
      throw claimError;
    }

    const message = `The claim failed: ${errorMessage(claimError)}; releasing it failed: ${errorMessage(releaseError)}`;

    throw new Error(message, { cause: claimError });
  }

  return owner;
};

// Polls until this process owns the lock and returns the path and owner record of its file. Each
// poll depends on the one before, so the loop awaits.
const acquireLock = async (
  options: FileLockOptions,
  claim: LockClaim,
): Promise<{ path: string; owner: LockOwner }> => {
  const { lockPath, signal, pollMilliseconds, onWaiting, cancelled } = options;
  let reportedHolder: string | undefined;

  for (;;) {
    if (signal?.aborted === true) {
      throw cancelled();
    }

    // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
    const { highest, holder, facts } = await findCurrentHolder(lockPath);

    if (highest === undefined || holderIsGone(facts)) {
      const next = (highest ?? 0) + 1;
      const path = generationPath(lockPath, next);

      // oxlint-disable-next-line no-await-in-loop -- Each attempt depends on the previous one.
      const owner = await claimGeneration(options, claim, next);

      if (owner !== undefined) {
        return { path, owner };
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
  const { lockPath, checkout, cancelled, terminal } = options;
  const token = options.token ?? newToken();

  const claim: LockClaim = {
    pid: process.pid,
    checkout,
    token,
    ...(terminal === undefined ? {} : { terminal }),
  };

  await mkdir(dirname(lockPath), { recursive: true });

  const { path, owner } = await acquireLock(options, claim);

  let result: T;

  try {
    if (options.signal?.aborted === true) {
      throw cancelled();
    }

    result = await run((groupId) =>
      rewriteOwnFile(path, owner, { ...owner, commandGroup: groupId }),
    );
  } catch (error) {
    await releaseOwnFile(path, owner).catch(() => undefined);

    throw error;
  }

  await releaseOwnFile(path, owner);

  return result;
};

// Holds the lock until the returned release runs. A live holder refuses at once instead of
// queueing. Filesystem errors reject.
export const holdFileLock = async (options: HoldFileLockOptions): Promise<HeldFileLock> => {
  const controller = new AbortController();
  const ready = Promise.withResolvers<() => Promise<void>>();

  const state: { refusal: { holder: LockOwner | undefined } | undefined } = { refusal: undefined };

  const { lockPath, checkout, terminal, token } = options;

  const holding = withFileLock(
    {
      lockPath,
      checkout,
      ...(terminal === undefined ? {} : { terminal }),
      ...(token === undefined ? {} : { token }),
      pollMilliseconds: 250,
      signal: controller.signal,
      cancelled: () => new Error('The lock is held by another session.'),
      onWaiting: (holder) => {
        state.refusal = { holder };
        controller.abort();
      },
    },
    async () => {
      const released = Promise.withResolvers<undefined>();

      ready.resolve(async () => {
        released.resolve(undefined);
        await holding;
      });

      await released.promise;
    },
  );

  const settled = holding.then(
    () => ({ kind: 'ended' as const }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );

  const acquired = await Promise.race([
    ready.promise.then((release) => ({ kind: 'ready' as const, release })),
    settled,
  ]);

  if (acquired.kind === 'ready') {
    return { kind: 'held', release: acquired.release };
  }

  const { refusal } = state;

  if (refusal !== undefined) {
    const holder = refusal.holder === undefined ? undefined : toLiveHolder(refusal.holder);

    return { kind: 'refused', holder };
  }

  if (acquired.kind === 'failed') {
    throw acquired.error;
  }

  throw new Error('The lock ended before it was taken.');
};
