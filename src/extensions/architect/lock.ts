import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { holdFileLock } from '../../fileLock/fileLock.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

export interface ArchitectLock {
  release: () => Promise<void>;
  token: string;
}

export const architectLockPath = (root: string): string => join(root, '.tau', 'architect', 'lock');

// Holds the checkout's architect lock until the returned release runs. A live holder refuses at
// once, so the caller can tell the user and shut down instead of queueing. The token names this
// holder in the architect record, so a lead can tell its route from a newer one.
export const holdArchitectLock = async (root: string): Promise<ArchitectLock> => {
  const directory = await ensureTauDirectory(root, 'architect');
  const token = randomUUID();

  const held = await holdFileLock({
    lockPath: join(directory, 'lock'),
    checkout: root,
    terminal: currentTerminalAddress(),
    token,
  });

  if (held.kind === 'refused') {
    throw new Error('The architect is already running in another session.');
  }

  return { release: held.release, token };
};
