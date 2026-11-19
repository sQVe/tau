import { spawn } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { holdFileLock, readLiveLockHolder } from './fileLock.js';
import type { HeldFileLock } from './fileLock.js';
import { fixture } from './fixtures/fileLockHarness.js';

const checkout = '/checkout';

const release = async (held: HeldFileLock): Promise<void> => {
  if (held.kind === 'held') {
    await held.release();
  }
};

it('refuses while a live holder has the lock and names its terminal', async ({
  onTestFinished,
}) => {
  const { lockPath } = fixture();
  const first = await holdFileLock({ lockPath, checkout, terminal: 't1' });

  onTestFinished(async () => {
    await release(first);
  });

  expect(first.kind).toBe('held');

  const second = await holdFileLock({ lockPath, checkout, terminal: 't2' });

  expect(second).toEqual({
    kind: 'refused',
    holder: { pid: process.pid, checkout, terminal: 't1' },
  });

  expect(await readLiveLockHolder(lockPath)).toEqual({
    pid: process.pid,
    checkout,
    terminal: 't1',
  });
});

it('takes a free lock and frees it on release', async () => {
  const { lockPath } = fixture();
  const held = await holdFileLock({ lockPath, checkout, terminal: undefined });

  expect(held.kind).toBe('held');

  expect(await readLiveLockHolder(lockPath)).toEqual({
    pid: process.pid,
    checkout,
    terminal: undefined,
  });

  await release(held);

  expect(await readLiveLockHolder(lockPath)).toBeUndefined();
});

it('takes over a lock whose holder process exited', async ({ onTestFinished }) => {
  const { lockPath } = fixture();
  const session = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const deadPid = session.pid ?? 0;

  await new Promise((resolve) => {
    session.once('close', resolve);
  });

  await mkdir(dirname(lockPath), { recursive: true });

  await writeFile(
    `${lockPath}.1`,
    JSON.stringify({
      pid: deadPid,
      checkout: '/gone',
      startedAt: new Date().toISOString(),
      token: 'dead',
    }),
  );

  const held = await holdFileLock({ lockPath, checkout, terminal: undefined });

  onTestFinished(async () => {
    await release(held);
  });

  expect(held.kind).toBe('held');
});

it('rejects with the filesystem error when the lock directory cannot be made', async () => {
  const { directory, lockPath } = fixture();

  await writeFile(join(directory, 'locks'), 'a file where the lock directory belongs');

  await expect(holdFileLock({ lockPath, checkout, terminal: undefined })).rejects.toMatchObject({
    code: 'EEXIST',
  });

  expect(await readdir(directory)).toEqual(['locks']);
});
