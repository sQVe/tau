import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionContext, SessionBeforeSwitchEvent } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { sessionLockPath } from '../../sessionLock/sessionLock.js';
import { guardResume, releaseSessionLock, startSessionLock } from './hold.js';

const isolatedAgentDirectory = (onTestFinished: TestContext['onTestFinished']): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-session-lock-hold-');
  const agentDirectory = join(directory, 'agent');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await releaseSessionLock('quit');
  });

  return agentDirectory;
};

it('takes no lock for a session with no file', async ({ onTestFinished }) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);

  await expect(startSessionLock(undefined, '/checkout')).resolves.toEqual({ kind: 'none' });
  expect(existsSync(join(agentDirectory, 'tau'))).toBe(false);
});

it('does not refuse a resume onto the session file this process holds', async ({
  onTestFinished,
}) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);
  const sessionFile = join(agentDirectory, 'session.jsonl');

  await expect(startSessionLock(sessionFile, '/checkout')).resolves.toEqual({ kind: 'held' });

  const notices: string[] = [];

  const context = {
    ui: { notify: (message: string) => notices.push(message) },
  } as unknown as ExtensionContext;

  const event: SessionBeforeSwitchEvent = {
    type: 'session_before_switch',
    reason: 'resume',
    targetSessionFile: sessionFile,
  };

  await expect(guardResume(event, context)).resolves.toBeUndefined();
  expect(notices).toEqual([]);
});

it('keeps the lock across a reload of the same file and frees it for any other shutdown', async ({
  onTestFinished,
}) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);
  const sessionFile = join(agentDirectory, 'session.jsonl');
  const lockPath = await sessionLockPath(agentDirectory, sessionFile);

  await startSessionLock(sessionFile, '/checkout');
  await releaseSessionLock('reload');

  expect(await readLiveLockHolder(lockPath)).toMatchObject({ pid: process.pid });
  await expect(startSessionLock(sessionFile, '/checkout')).resolves.toEqual({ kind: 'held' });

  for (const reason of ['quit', 'new', 'resume', 'fork'] as const) {
    await releaseSessionLock(reason);

    expect(await readLiveLockHolder(lockPath)).toBeUndefined();

    await startSessionLock(sessionFile, '/checkout');
  }
});

it('frees the old lock when the next start is a different file', async ({ onTestFinished }) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);
  const first = join(agentDirectory, 'first.jsonl');
  const second = join(agentDirectory, 'second.jsonl');
  const firstLock = await sessionLockPath(agentDirectory, first);
  const secondLock = await sessionLockPath(agentDirectory, second);

  await startSessionLock(first, '/checkout');
  await releaseSessionLock('reload');
  await startSessionLock(second, '/checkout');

  expect(await readLiveLockHolder(firstLock)).toBeUndefined();
  expect(await readLiveLockHolder(secondLock)).toMatchObject({ pid: process.pid });
});

it('keeps the lease when a reload loads the module again', async ({ onTestFinished }) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);
  const sessionFile = join(agentDirectory, 'session.jsonl');
  const lockPath = await sessionLockPath(agentDirectory, sessionFile);

  await startSessionLock(sessionFile, '/checkout');
  await releaseSessionLock('reload');

  vi.resetModules();

  const reloaded = await import('./hold.js');

  onTestFinished(async () => {
    await reloaded.releaseSessionLock('quit');
  });

  await expect(reloaded.startSessionLock(sessionFile, '/checkout')).resolves.toEqual({
    kind: 'held',
  });

  await reloaded.releaseSessionLock('quit');

  expect(await readLiveLockHolder(lockPath)).toBeUndefined();
});
