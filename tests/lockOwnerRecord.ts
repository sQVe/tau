import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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
