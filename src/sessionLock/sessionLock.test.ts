import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { holdFileLock, readLiveLockHolder } from '../fileLock/fileLock.js';
import { sessionLockPath } from './sessionLock.js';

const agentDirectoryFor = (onTestFinished: Parameters<typeof temporaryDirectory>[0]): string => {
  const directory = temporaryDirectory(onTestFinished, 'tau-session-lock-');

  return join(directory, 'agent');
};

// The saved location a lock written before this module existed uses. A test seeds it without the
// production path builder, so a changed component makes the seeded lock invisible.
const savedLockPath = (agentDirectory: string, sessionFile: string): string => {
  const digest = createHash('sha256').update(realpathSync(sessionFile)).digest('hex');

  return join(agentDirectory, 'tau', 'session-locks', digest, 'lock');
};

it('gives one lock path to a session file and a symlink to it', async ({ onTestFinished }) => {
  const agentDirectory = agentDirectoryFor(onTestFinished);
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
  const agentDirectory = agentDirectoryFor(onTestFinished);

  expect(await sessionLockPath(agentDirectory, join(agentDirectory, 'one.jsonl'))).not.toBe(
    await sessionLockPath(agentDirectory, join(agentDirectory, 'two.jsonl')),
  );
});

it('reads a lock seeded at the saved location without changing it', async ({ onTestFinished }) => {
  const agentDirectory = agentDirectoryFor(onTestFinished);
  const sessionFile = join(agentDirectory, 'session.jsonl');

  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(sessionFile, '');

  const lockPath = savedLockPath(agentDirectory, sessionFile);
  const held = await holdFileLock({ lockPath, checkout: '/other', terminal: 't-old' });

  onTestFinished(async () => {
    if (held.kind === 'held') {
      await held.release();
    }
  });

  expect(held.kind).toBe('held');

  const generation = `${lockPath}.1`;
  const bytes = readFileSync(generation);
  const entries = readdirSync(dirname(lockPath)).toSorted();

  const readPath = await sessionLockPath(agentDirectory, sessionFile);
  const holder = await readLiveLockHolder(readPath);

  expect(holder).toMatchObject({ pid: process.pid, terminal: 't-old' });

  expect(readFileSync(generation)).toEqual(bytes);

  const entriesAfter = readdirSync(dirname(lockPath)).toSorted();

  expect(entriesAfter).toEqual(entries);
});

it('reads no holder and creates nothing when the lock directory is missing', async ({
  onTestFinished,
}) => {
  const agentDirectory = agentDirectoryFor(onTestFinished);
  const sessionFile = join(agentDirectory, 'session.jsonl');

  const lockPath = await sessionLockPath(agentDirectory, sessionFile);

  expect(await readLiveLockHolder(lockPath)).toBe(undefined);
  expect(existsSync(join(agentDirectory, 'tau'))).toBe(false);
});

it('reads no holder and repairs nothing when the highest generation is malformed', async ({
  onTestFinished,
}) => {
  const agentDirectory = agentDirectoryFor(onTestFinished);
  const sessionFile = join(agentDirectory, 'session.jsonl');
  const lockPath = await sessionLockPath(agentDirectory, sessionFile);
  const generation = `${lockPath}.1`;

  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(generation, 'not json');

  const bytes = readFileSync(generation);

  expect(await readLiveLockHolder(lockPath)).toBe(undefined);
  expect(readFileSync(generation)).toEqual(bytes);
  expect(readdirSync(dirname(lockPath))).toEqual(['lock.1']);
});
