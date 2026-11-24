import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { listGenerations } from '../src/fileLock/fileLock.js';

interface LockOwnerRecord {
  pid: number;
  checkout?: string;
  terminal?: string;
  token?: string;
}

const ownerRecord = (owner: LockOwnerRecord): Record<string, unknown> => ({
  pid: owner.pid,
  checkout: owner.checkout ?? '/other',
  startedAt: new Date().toISOString(),
  token: owner.token ?? 'other',
  ...(owner.terminal === undefined ? {} : { terminal: owner.terminal }),
});

// Writes the first generation of a lock, as an earlier Pi would have left it.
export const writeLockOwnerRecord = async (
  lockPath: string,
  owner: LockOwnerRecord,
): Promise<void> => {
  await mkdir(dirname(lockPath), { recursive: true });

  await writeFile(`${lockPath}.1`, JSON.stringify(ownerRecord(owner)));
};

// Writes the next generation without awaiting, as a child that takes the claim over does before
// the caller's probe runs.
export const writeNextLockOwnerRecordSync = (lockPath: string, owner: LockOwnerRecord): void => {
  const prefix = `${basename(lockPath)}.`;

  const generations = readdirSync(dirname(lockPath))
    .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)));

  const next = Math.max(0, ...generations) + 1;

  writeFileSync(`${lockPath}.${next}`, JSON.stringify(ownerRecord(owner)));

  for (const generation of generations) {
    rmSync(`${lockPath}.${generation}`, { force: true });
  }
};

// Reads the newest generation's record, as a test needs to see that a refused write changed
// nothing.
export const readLockOwnerRecord = async (
  lockPath: string,
): Promise<Record<string, unknown> | undefined> => {
  const generation = (await listGenerations(lockPath)).at(-1);

  if (generation === undefined) {
    return undefined;
  }

  const text = await readFile(`${lockPath}.${generation}`, 'utf8');

  return JSON.parse(text) as Record<string, unknown>;
};

// Rewrites the newest generation's pid, as a child taking the claim over would.
export const replaceCurrentLockOwnerPid = async (
  lockPath: string,
  processId: number,
): Promise<void> => {
  const generation = (await listGenerations(lockPath)).at(-1);

  if (generation === undefined) {
    throw new Error(`The lock at ${lockPath} has no generation.`);
  }

  const path = `${lockPath}.${generation}`;
  const owner = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const staging = `${path}.rewrite`;

  await writeFile(staging, JSON.stringify({ ...owner, pid: processId }));
  await rename(staging, path);
};
