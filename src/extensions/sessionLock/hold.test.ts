import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { releaseSessionLock, sessionLockPath, startSessionLock, switchRefusal } from './hold.js';

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
  await expect(switchRefusal(sessionFile)).resolves.toBeUndefined();
});

it('gives one lock path to a session file and a symlink to it', async ({ onTestFinished }) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);
  const sessionFile = join(agentDirectory, 'session.jsonl');
  const alias = join(agentDirectory, 'alias.jsonl');

  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(sessionFile, '');
  symlinkSync(sessionFile, alias);

  expect(await sessionLockPath(agentDirectory, alias)).toBe(
    await sessionLockPath(agentDirectory, sessionFile),
  );
});

it('gives different lock paths to different session files', async ({ onTestFinished }) => {
  const agentDirectory = isolatedAgentDirectory(onTestFinished);

  expect(await sessionLockPath(agentDirectory, join(agentDirectory, 'one.jsonl'))).not.toBe(
    await sessionLockPath(agentDirectory, join(agentDirectory, 'two.jsonl')),
  );
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
