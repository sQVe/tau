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
import { isRecord } from '../../schema.js';
import { describeSessionHolder, sessionLockPath } from '../../sessionLock/sessionLock.js';
import { decideResume, decideShutdown, decideStart, needsResumeCheck } from './lockDecision.js';
import type { ResumeHolderFact, StartFacts } from './lockDecision.js';

interface HeldSessionLock {
  lockPath: string;
  release: () => Promise<void>;
}

type SessionLockStart =
  | { kind: 'none' }
  | { kind: 'held' }
  | { kind: 'refused'; sessionFile: string; holder: LiveLockHolder | undefined };

interface SessionLockState {
  held: HeldSessionLock | undefined;
}

// Pi loads this module again on a reload, so the held lock lives on globalThis, not in the module.
const stateKey = Symbol.for('tau.sessionLock.held');

const isHeldSessionLock = (value: unknown): value is HeldSessionLock =>
  isRecord(value) &&
  typeof value['lockPath'] === 'string' &&
  typeof value['release'] === 'function';

const isSessionLockState = (value: unknown): value is SessionLockState => {
  if (!isRecord(value) || !('held' in value)) {
    return false;
  }

  return value['held'] === undefined || isHeldSessionLock(value['held']);
};

const sharedState = (): SessionLockState => {
  const existing: unknown = Object.getOwnPropertyDescriptor(globalThis, stateKey)?.value;

  if (isSessionLockState(existing)) {
    return existing;
  }

  const created: SessionLockState = { held: undefined };

  Reflect.set(globalThis, stateKey, created);

  return created;
};

const state = sharedState();

const refusalMessage = (sessionFile: string, holder: LiveLockHolder | undefined): string =>
  `Session ${sessionFile} is open in ${describeSessionHolder(holder)}. This Pi exits.`;

const releaseHeld = async (): Promise<void> => {
  const { held } = state;

  state.held = undefined;
  await held?.release();
};

export const startSessionLock = async (
  sessionFile: string | undefined,
  checkout: string,
): Promise<SessionLockStart> => {
  const heldLockPath = state.held?.lockPath;

  const facts: StartFacts =
    sessionFile === undefined
      ? { kind: 'no-file', heldLockPath }
      : { kind: 'file', heldLockPath, lockPath: await sessionLockPath(getAgentDir(), sessionFile) };

  const plan = decideStart(facts);

  if (plan === 'keep') {
    return { kind: 'held' };
  }

  await releaseHeld();

  if (facts.kind === 'no-file' || sessionFile === undefined) {
    return { kind: 'none' };
  }

  const { lockPath } = facts;
  const acquired = await holdFileLock({ lockPath, checkout, terminal: currentTerminalAddress() });

  if (acquired.kind === 'refused') {
    return { kind: 'refused', sessionFile, holder: acquired.holder };
  }

  state.held = { lockPath, release: acquired.release };

  return { kind: 'held' };
};

export const releaseSessionLock = async (reason: SessionShutdownEvent['reason']): Promise<void> => {
  if (decideShutdown(reason) === 'release') {
    await releaseHeld();
  }
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

const resumeRefusal = (targetSessionFile: string, holder: LiveLockHolder | undefined): string =>
  `Session ${targetSessionFile} is open in ${describeSessionHolder(holder)}. Resume cancelled.`;

export const guardResume = async (
  event: SessionBeforeSwitchEvent,
  context: ExtensionContext,
): Promise<{ cancel: true } | undefined> => {
  const { reason, targetSessionFile } = event;

  if (!needsResumeCheck(reason, targetSessionFile) || targetSessionFile === undefined) {
    return undefined;
  }

  let holder: LiveLockHolder | undefined;
  let failure: unknown;
  let fact: ResumeHolderFact;

  try {
    holder = await readLiveLockHolder(await sessionLockPath(getAgentDir(), targetSessionFile));
    fact = { read: 'ok', holderPid: holder?.pid, ownPid: process.pid };
  } catch (error) {
    failure = error;
    fact = { read: 'failed' };
  }

  const plan = decideResume(fact);

  if (plan === 'allow-with-warning') {
    warnLockFailure(context, failure);
  }

  if (plan !== 'refuse') {
    return undefined;
  }

  context.ui.notify(resumeRefusal(targetSessionFile, holder), 'error');

  return { cancel: true };
};
