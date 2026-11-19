import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionContext,
  SessionBeforeSwitchEvent,
  SessionShutdownEvent,
} from '@earendil-works/pi-coding-agent';

import { errorMessage } from '../../errors.js';
import { holdFileLock, readLiveLockHolder } from '../../fileLock/fileLock.js';
import type { LiveLockHolder } from '../../fileLock/fileLock.js';
import { currentTerminalAddress } from '../../hc/hc.js';

interface HeldSessionLock {
  lockPath: string;
  release: () => Promise<void>;
}

type SessionLockStart =
  | { kind: 'none' }
  | { kind: 'held' }
  | { kind: 'refused'; sessionFile: string; holder: LiveLockHolder | undefined };

// A reload ends one extension runner and starts another in the same process, so the held lock
// lives here and not in a closure.
const state: { held: HeldSessionLock | undefined } = { held: undefined };

const canonicalSessionFile = async (sessionFile: string): Promise<string> => {
  const resolvedFile = await realpath(sessionFile).catch(() => undefined);

  if (resolvedFile !== undefined) {
    return resolvedFile;
  }

  const directory = dirname(sessionFile);
  const resolvedDirectory = await realpath(directory).catch(() => resolve(directory));

  return join(resolvedDirectory, basename(sessionFile));
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

const refusalMessage = (sessionFile: string, holder: LiveLockHolder | undefined): string =>
  `Session ${sessionFile} is open in ${describeHolder(holder)}. This Pi exits.`;

const releaseHeld = async (): Promise<void> => {
  const { held } = state;

  state.held = undefined;
  await held?.release();
};

export const startSessionLock = async (
  sessionFile: string | undefined,
  checkout: string,
): Promise<SessionLockStart> => {
  if (sessionFile === undefined) {
    await releaseHeld();

    return { kind: 'none' };
  }

  const lockPath = await sessionLockPath(getAgentDir(), sessionFile);

  if (state.held?.lockPath === lockPath) {
    return { kind: 'held' };
  }

  await releaseHeld();

  const acquired = await holdFileLock({ lockPath, checkout, terminal: currentTerminalAddress() });

  if (acquired.kind === 'refused') {
    return { kind: 'refused', sessionFile, holder: acquired.holder };
  }

  state.held = { lockPath, release: acquired.release };

  return { kind: 'held' };
};

// A reload shuts the session down and starts it again on the same file, so the lock stays held.
export const releaseSessionLock = async (reason: SessionShutdownEvent['reason']): Promise<void> => {
  if (reason === 'reload') {
    return;
  }

  await releaseHeld();
};

export const switchRefusal = async (targetSessionFile: string): Promise<string | undefined> => {
  const lockPath = await sessionLockPath(getAgentDir(), targetSessionFile);
  const holder = await readLiveLockHolder(lockPath);

  if (holder === undefined || holder.pid === process.pid) {
    return undefined;
  }

  return `Session ${targetSessionFile} is open in ${describeHolder(holder)}. Resume cancelled.`;
};

const exitAfterRefusal = async (context: ExtensionContext, message: string): Promise<never> => {
  context.ui.notify(message, 'error');

  process.once('exit', () => {
    process.stderr.write(`${message}\n`);
  });

  context.shutdown();

  // Pi runs the remaining session_start handlers once this one settles, so it must not settle.
  const never = Promise.withResolvers<never>();

  return never.promise;
};

const warnLockFailure = (context: ExtensionContext, error: unknown): void => {
  context.ui.notify(`Session lock failed: ${errorMessage(error)}`, 'warning');
};

export const lockSessionOnStart = async (context: ExtensionContext): Promise<void> => {
  try {
    const started = await startSessionLock(context.sessionManager.getSessionFile(), context.cwd);

    if (started.kind === 'refused') {
      await exitAfterRefusal(context, refusalMessage(started.sessionFile, started.holder));
    }
  } catch (error) {
    warnLockFailure(context, error);
  }
};

export const guardResume = async (
  event: SessionBeforeSwitchEvent,
  context: ExtensionContext,
): Promise<{ cancel: true } | undefined> => {
  if (event.reason !== 'resume' || event.targetSessionFile === undefined) {
    return undefined;
  }

  try {
    const message = await switchRefusal(event.targetSessionFile);

    if (message === undefined) {
      return undefined;
    }

    context.ui.notify(message, 'error');

    return { cancel: true };
  } catch (error) {
    warnLockFailure(context, error);

    return undefined;
  }
};
