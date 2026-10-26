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

// Checks of one repository share a lock, since they share resources such as Docker ports. The names
// ignore case like GitHub names do, and encoding keeps the path separator out of the file name.
export const defaultLockPath = (agentDirectory: string, repository: string): string =>
  join(agentDirectory, 'tau', 'full-check', `${encodeURIComponent(repository.toLowerCase())}.lock`);
