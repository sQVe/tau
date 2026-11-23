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

export interface ArchitectClaimOptions {
  beforeLink?: () => Promise<void>;
  beforeDispatch?: () => Promise<void>;
}

export const architectLockPath = (root: string): string => join(root, '.tau', 'architect', 'lock');

const ensureArchitectLockPath = async (root: string): Promise<string> => {
  const directory = await ensureTauDirectory(root, 'architect');

  return join(directory, 'lock');
};

// Reserves the lock before the caller starts Pi. The started Pi adopts this token, so the claim
// names no terminal of its own.
export const claimArchitectLock = async (
  root: string,
  options: ArchitectClaimOptions = {},
): Promise<ArchitectClaim> => {
  const token = randomUUID();

  const held = await holdFileLock({
    lockPath: await ensureArchitectLockPath(root),
    checkout: root,
    terminal: undefined,
    token,
    ...(options.beforeLink === undefined ? {} : { beforeLink: options.beforeLink }),
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
  const token = randomUUID();

  const held = await holdFileLock({
    lockPath: await ensureArchitectLockPath(root),
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
