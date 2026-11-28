import type { ConfigWarnings } from '../../../config/config.js';
import { errorMessage } from '../../../errors.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import type { LiveLockHolder } from '../../../fileLock/fileLock.js';
import { describeSessionHolder, sessionLockPath } from '../../../sessionLock/sessionLock.js';

const heldSessionMessage = (sessionFile: string, holder: LiveLockHolder): string =>
  `The architect session ${sessionFile} is open in ${describeSessionHolder(holder)}. End that Pi once it is idle, then call architect open again.`;

const lockReadWarning = (error: unknown): string =>
  `The architect session lock could not be read, so architect open resumes without the check: ${errorMessage(error)}`;

// The launched Pi reads the same lock and starts when the read fails, so a failed read must not
// refuse the resume here.
const readSessionHolder = async (
  agentDirectory: string,
  sessionFile: string,
  ui: ConfigWarnings,
): Promise<LiveLockHolder | undefined> => {
  try {
    const lockPath = await sessionLockPath(agentDirectory, sessionFile);

    return await readLiveLockHolder(lockPath);
  } catch (error) {
    ui.notify(lockReadWarning(error), 'warning');

    return undefined;
  }
};

export const refuseHeldSession = async (
  agentDirectory: string,
  sessionFile: string,
  ui: ConfigWarnings,
): Promise<void> => {
  const holder = await readSessionHolder(agentDirectory, sessionFile, ui);

  if (holder === undefined) {
    return;
  }

  throw new Error(heldSessionMessage(sessionFile, holder));
};
