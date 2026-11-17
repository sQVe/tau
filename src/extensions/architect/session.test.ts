import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { ownerJson } from '../../fileLock/fixtures/fileLockHarness.js';
import { architectLockPath } from './lock.js';
import { readArchitectRecord } from './record.js';
import { endArchitectSession, startArchitectSession } from './session.js';

const sessionContext = (cwd: string) => {
  const notify = vi.fn<(message: string, level?: string) => void>();
  const shutdown = vi.fn<() => void>();

  const context = {
    cwd,
    ui: { notify },
    shutdown,
    isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => '/sessions/architect.jsonl' },
  } as unknown as ExtensionContext;

  return { context, notify, shutdown };
};

const holdLock = async (root: string, released: boolean): Promise<void> => {
  const path = `${architectLockPath(root)}.1`;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, ownerJson('holder', released));
};

const stubArchitect = (cleanup: (cleanup: () => void) => void): void => {
  vi.stubEnv('TAU_ROLE', 'architect');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  cleanup(() => {
    vi.unstubAllEnvs();
  });
};

it('a held lock notifies and shuts the architect down', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const { context, notify, shutdown } = sessionContext(root);

  await holdLock(root, false);

  expect(await startArchitectSession(context)).toBeUndefined();

  expect(notify).toHaveBeenCalledWith(
    'The architect is already running in another session.',
    'error',
  );

  expect(shutdown).toHaveBeenCalledTimes(1);
});

it('a released lock starts the architect and writes its record', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const { context, notify, shutdown } = sessionContext(root);

  await holdLock(root, true);

  const session = await startArchitectSession(context);

  expect(session).toBeDefined();
  expect(notify).not.toHaveBeenCalled();
  expect(shutdown).not.toHaveBeenCalled();

  expect(await readArchitectRecord(root)).toMatchObject({
    version: 1,
    sessionFile: '/sessions/architect.jsonl',
    terminal: 't-architect',
  });

  expect(await readLiveLockHolder(architectLockPath(root))).toEqual({
    pid: process.pid,
    checkout: root,
  });

  await endArchitectSession(session as NonNullable<typeof session>);

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('a non-architect session takes no lock', async ({ onTestFinished }) => {
  vi.stubEnv('TAU_ROLE', 'lead');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);

  expect(await startArchitectSession(context)).toBeUndefined();
  expect(await readArchitectRecord(root)).toBeUndefined();
});
