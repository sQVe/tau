import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { withFileLock } from '../../fileLock/fileLock.js';
import type { FileLockOptions } from '../../fileLock/fileLock.js';

export const withFullCheckLock = <Value>(
  options: Omit<FileLockOptions, 'cancelled'>,
  run: (recordCommandGroup: (groupId: number) => Promise<void>) => Promise<Value>,
): Promise<Value> =>
  withFileLock(
    { ...options, cancelled: () => new Error('The check was cancelled while it waited.') },
    run,
  );

const lockDirectory = (agentDirectory: string): string => join(agentDirectory, 'tau', 'full-check');

// The names ignore case like GitHub names do, and encoding keeps the path separator out of the file
// name.
export const repositoryLockPath = (agentDirectory: string, repository: string): string =>
  join(lockDirectory(agentDirectory), `${encodeURIComponent(repository.toLowerCase())}.lock`);

// A hash keeps a deep checkout path within the file name length limit.
export const checkoutLockPath = (agentDirectory: string, checkout: string): string => {
  const digest = createHash('sha256').update(checkout).digest('hex');

  return join(lockDirectory(agentDirectory), `checkout-${digest}.lock`);
};
