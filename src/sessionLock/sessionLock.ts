import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { canonicalSessionFile } from './canonicalSessionFile.js';

export const sessionLockPath = async (
  agentDirectory: string,
  sessionFile: string,
): Promise<string> => {
  const canonical = await canonicalSessionFile(sessionFile);
  const digest = createHash('sha256').update(canonical).digest('hex');

  return join(agentDirectory, 'tau', 'session-locks', digest, 'lock');
};

export const describeSessionHolder = (
  holder: { pid: number; terminal: string | undefined } | undefined,
): string => {
  if (holder === undefined) {
    return 'another Pi';
  }

  const terminal = holder.terminal === undefined ? 'no hc terminal' : `terminal ${holder.terminal}`;

  return `another Pi (${terminal}, pid ${String(holder.pid)})`;
};
