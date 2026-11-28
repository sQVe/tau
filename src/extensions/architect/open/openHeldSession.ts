import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import type { LiveLockHolder } from '../../../fileLock/fileLock.js';
import { describeSessionHolder, sessionLockPath } from '../../../sessionLock/sessionLock.js';

const heldSessionMessage = (sessionFile: string, holder: LiveLockHolder): string =>
  `The architect session ${sessionFile} is open in ${describeSessionHolder(holder)}. End that Pi once it is idle, then call architect open again.`;

export const refuseHeldSession = async (
  agentDirectory: string,
  sessionFile: string,
): Promise<void> => {
  const holder = await readLiveLockHolder(await sessionLockPath(agentDirectory, sessionFile));

  if (holder === undefined) {
    return;
  }

  throw new Error(heldSessionMessage(sessionFile, holder));
};
