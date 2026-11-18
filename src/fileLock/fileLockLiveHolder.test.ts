import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, it } from 'vitest';

import { readLiveLockHolder, withFileLock } from './fileLock.js';
import { cancelled, fixture, ownerJson } from './fixtures/fileLockHarness.js';

const writeOwner = async (lockPath: string, owner: string): Promise<void> => {
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(`${lockPath}.1`, owner);
};

it('reads a live holder with the time it started', async () => {
  const { lockPath } = fixture();
  const startedAt = '2026-11-18T10:00:00.000Z';

  await writeOwner(
    lockPath,
    JSON.stringify({ pid: process.pid, checkout: '/other', startedAt, token: 'live' }),
  );

  expect(await readLiveLockHolder(lockPath)).toEqual({
    pid: process.pid,
    checkout: '/other',
    startedAt,
    token: 'live',
  });
});

it('reads a lock file without a token as an empty token', async () => {
  const { lockPath } = fixture();

  const startedAt = new Date().toISOString();

  await writeOwner(lockPath, JSON.stringify({ pid: process.pid, checkout: '/other', startedAt }));

  expect(await readLiveLockHolder(lockPath)).toEqual({
    pid: process.pid,
    checkout: '/other',
    startedAt,
    token: '',
  });
});

it('uses the token the caller gives it', async () => {
  const { lockPath } = fixture();

  await withFileLock(
    {
      lockPath,
      checkout: '/repo',
      cancelled,
      signal: undefined,
      pollMilliseconds: 1,
      onWaiting: () => undefined,
      token: 'given-token',
    },
    async () => {
      expect(await readLiveLockHolder(lockPath)).toMatchObject({
        pid: process.pid,
        checkout: '/repo',
        token: 'given-token',
      });
    },
  );
});

it('does not read a released holder', async () => {
  const { lockPath } = fixture();

  await writeOwner(lockPath, ownerJson('released', true));

  expect(await readLiveLockHolder(lockPath)).toBeUndefined();
});

it('does not read a missing lock', async () => {
  const { lockPath } = fixture();

  expect(await readLiveLockHolder(lockPath)).toBeUndefined();
});

it("reads the holder's terminal", async () => {
  const { lockPath } = fixture();
  const record = JSON.parse(ownerJson('live')) as Record<string, unknown>;

  await writeOwner(lockPath, JSON.stringify({ ...record, terminal: 't7' }));

  expect(await readLiveLockHolder(lockPath)).toHaveProperty('terminal', 't7');

  await writeOwner(lockPath, ownerJson('live'));

  expect(await readLiveLockHolder(lockPath)).toHaveProperty('terminal', undefined);
});

it.each([
  { name: 'an empty string', terminal: '' },
  { name: 'a number', terminal: 7 },
  { name: 'null', terminal: null },
])('reads a live holder with $name as its terminal without a terminal', async ({ terminal }) => {
  const { lockPath } = fixture();
  const record = JSON.parse(ownerJson('live')) as Record<string, unknown>;

  await writeOwner(lockPath, JSON.stringify({ ...record, terminal }));

  expect(await readLiveLockHolder(lockPath)).toEqual({
    pid: process.pid,
    checkout: '/other',
    terminal: undefined,
  });
});
