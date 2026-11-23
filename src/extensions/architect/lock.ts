import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { holdFileLock } from '../../fileLock/fileLock.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

export interface ArchitectLock {
  release: () => Promise<void>;
  token: string;
}

export type ArchitectClaim =
  | { kind: 'claimed'; release: () => Promise<void>; token: string }
  | { kind: 'refused' };

export const architectLockPath = (root: string): string => join(root, '.tau', 'architect', 'lock');

// Reserves the lock before the caller starts Pi. The started Pi adopts this token, so the claim
// names no terminal of its own.
export const claimArchitectLock = async (root: string): Promise<ArchitectClaim> => {
  const token = randomUUID();

  const held = await holdFileLock({
    lockPath: architectLockPath(root),
    checkout: root,
    terminal: undefined,
    token,
  });

  if (held.kind === 'refused') {
    return { kind: 'refused' };
  }

  return { kind: 'claimed', release: held.release, token };
};

export const holdArchitectLock = async (
  root: string,
  adoptToken?: string,
): Promise<ArchitectLock> => {
  const directory = await ensureTauDirectory(root, 'architect');
  const token = randomUUID();

  const held = await holdFileLock({
    lockPath: join(directory, 'lock'),
    checkout: root,
    terminal: currentTerminalAddress(),
    token,
    ...(adoptToken === undefined ? {} : { adopt: adoptToken }),
  });

  if (held.kind === 'refused') {
    throw new Error('The architect is already running in another session.');
  }

  return { release: held.release, token };
};
