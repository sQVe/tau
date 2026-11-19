import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { holdFileLock, readLiveLockHolder } from '../../fileLock/fileLock.js';
import type { HeldFileLock, LiveLockHolder } from '../../fileLock/fileLock.js';
import { currentTerminalAddress } from '../../hc/hc.js';

const canonicalSessionFile = async (sessionFile: string): Promise<string> => {
  const directory = dirname(sessionFile);
  const resolved = await realpath(directory).catch(() => resolve(directory));

  return join(resolved, basename(sessionFile));
};

export const sessionLockPath = async (
  agentDirectory: string,
  sessionFile: string,
): Promise<string> => {
  const canonical = await canonicalSessionFile(sessionFile);
  const digest = createHash('sha256').update(canonical).digest('hex');

  return join(agentDirectory, 'tau', 'session-locks', digest, 'lock');
};

const describeHolder = (holder: LiveLockHolder | undefined): string => {
  if (holder === undefined) {
    return 'another Pi';
  }

  const terminal = holder.terminal === undefined ? 'no hc terminal' : `terminal ${holder.terminal}`;

  return `another Pi (${terminal}, pid ${String(holder.pid)})`;
};

export const refusalMessage = (sessionFile: string, holder: LiveLockHolder | undefined): string =>
  `Session ${sessionFile} is open in ${describeHolder(holder)}. This Pi exits.`;

export const holdSessionLock = async (
  sessionFile: string | undefined,
  checkout: string,
): Promise<{ kind: 'none' } | HeldFileLock> => {
  if (sessionFile === undefined) {
    return { kind: 'none' };
  }

  const lockPath = await sessionLockPath(getAgentDir(), sessionFile);

  return holdFileLock({ lockPath, checkout, terminal: currentTerminalAddress() });
};

export const switchRefusal = async (targetSessionFile: string): Promise<string | undefined> => {
  const lockPath = await sessionLockPath(getAgentDir(), targetSessionFile);
  const holder = await readLiveLockHolder(lockPath);

  if (holder === undefined || holder.pid === process.pid) {
    return undefined;
  }

  return `Session ${targetSessionFile} is open in ${describeHolder(holder)}. Resume cancelled.`;
};
