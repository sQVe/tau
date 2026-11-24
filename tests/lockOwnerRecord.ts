import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

interface LockOwnerRecord {
  pid: number;
  checkout?: string;
  terminal?: string;
  token?: string;
}

// Writes the first generation of a lock, as an earlier Pi would have left it.
export const writeLockOwnerRecord = async (
  lockPath: string,
  owner: LockOwnerRecord,
): Promise<void> => {
  await mkdir(dirname(lockPath), { recursive: true });

  await writeFile(
    `${lockPath}.1`,
    JSON.stringify({
      pid: owner.pid,
      checkout: owner.checkout ?? '/other',
      startedAt: new Date().toISOString(),
      token: owner.token ?? 'other',
      ...(owner.terminal === undefined ? {} : { terminal: owner.terminal }),
    }),
  );
};

// Rewrites the newest generation's pid, as a child taking the claim over would.
export const replaceCurrentLockOwnerPid = async (
  lockPath: string,
  processId: number,
): Promise<void> => {
  const prefix = `${basename(lockPath)}.`;

  const generations = (await readdir(dirname(lockPath)))
    .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
    .map((name) => Number(name.slice(prefix.length)));

  const generation = generations.toSorted((left, right) => left - right).at(-1);

  if (generation === undefined) {
    throw new Error(`The lock at ${lockPath} has no generation.`);
  }

  const path = `${lockPath}.${generation}`;
  const owner = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

  await writeFile(path, JSON.stringify({ ...owner, pid: processId }));
};
