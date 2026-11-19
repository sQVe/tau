import { join } from 'node:path';

import { holdFileLock } from '../../fileLock/fileLock.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

export const architectLockPath = (root: string): string => join(root, '.tau', 'architect', 'lock');

// Holds the checkout's architect lock until the returned release runs. A live holder refuses at
// once, so the caller can tell the user and shut down instead of queueing.
export const holdArchitectLock = async (root: string): Promise<() => Promise<void>> => {
  const directory = await ensureTauDirectory(root, 'architect');

  const held = await holdFileLock({
    lockPath: join(directory, 'lock'),
    checkout: root,
    terminal: currentTerminalAddress(),
  });

  if (held.kind === 'refused') {
    throw new Error('The architect is already running in another session.');
  }

  return held.release;
};
