import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { ownerJson } from '../../fileLock/fixtures/fileLockHarness.js';
import { architectLockPath } from './lock.js';
import {
  askRecordDirectory,
  readArchitectRecord,
  readAskRecord,
  writeAskRecord,
} from './record.js';
import type { HiddenAskRecord, LiveAskRecord } from './record.js';
import { endArchitectSession, startArchitectSession } from './session.js';

const sessionContext = (cwd: string) => {
  const notify = vi.fn<(message: string, level?: string) => void>();
  const shutdown = vi.fn<() => void>();

  const context = {
    cwd,
    ui: { notify },
    shutdown,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionFile: () => '/sessions/architect.jsonl',
      getSessionId: () => 'session-architect',
    },
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
    version: 2,
    sessionFile: '/sessions/architect.jsonl',
    owner: { mode: 'visible', terminal: 't-architect', sessionId: 'session-architect' },
  });

  const holder = await readLiveLockHolder(architectLockPath(root));
  const record = await readArchitectRecord(root);

  expect(holder?.pid).toBe(process.pid);
  expect(holder?.checkout).toBe(root);
  expect(holder?.terminal).toBe('t-architect');
  expect(holder?.token).toMatch(/^[0-9a-f-]{36}$/);
  expect(holder?.token).toBe(record?.owner?.lockToken);

  await endArchitectSession(session as NonNullable<typeof session>);

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('an ask session records ask mode', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);
  vi.stubEnv('TAU_ARCHITECT_ASK', '/sessions/ask.json');

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context);

  expect((await readArchitectRecord(root))?.owner?.mode).toBe('ask');

  await endArchitectSession(session as NonNullable<typeof session>);
});

it('an empty ask path records visible mode', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);
  vi.stubEnv('TAU_ARCHITECT_ASK', '');

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context);

  expect((await readArchitectRecord(root))?.owner?.mode).toBe('visible');

  await endArchitectSession(session as NonNullable<typeof session>);
});

const hiddenAsk = (askId: string, status: HiddenAskRecord['status']): HiddenAskRecord => ({
  version: 2,
  route: 'hidden',
  askId,
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  sessionFile: '/sessions/architect.jsonl',
  terminal: 't-ask',
  leadTerminal: 't-lead',
  deadline: 1900000000000,
  status,
  detail: null,
  answer: null,
});

const liveAsk = (askId: string, status: LiveAskRecord['status']): LiveAskRecord => ({
  version: 2,
  route: 'live',
  askId,
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId: 'session-architect',
  status,
  detail: null,
  answer: null,
});

it('ending fails only running hidden asks', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAskRecord(root, hiddenAsk('running', 'running'));
  await writeAskRecord(root, hiddenAsk('sent', 'sent'));
  await writeAskRecord(root, liveAsk('live', 'sending'));

  const notify = vi.fn<(message: string, level?: string) => void>();

  await endArchitectSession({ root, release: () => Promise.resolve(), ui: { notify } });

  expect(await readAskRecord(root, 'running')).toMatchObject({ status: 'failed' });
  expect(await readAskRecord(root, 'sent')).toMatchObject({ status: 'sent' });
  expect(await readAskRecord(root, 'live')).toMatchObject({ status: 'sending' });
});

it('ending reports a bad ask file and still fails the running ask', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const notify = vi.fn<(message: string, level?: string) => void>();

  await writeAskRecord(root, hiddenAsk('running', 'running'));
  await mkdir(askRecordDirectory(root), { recursive: true });
  await writeFile(join(askRecordDirectory(root), 'malformed.json'), '{"version":2');

  await endArchitectSession({ root, release: () => Promise.resolve(), ui: { notify } });

  expect(notify).toHaveBeenCalledWith(expect.stringContaining('Malformed ask record'), 'warning');
  expect(await readAskRecord(root, 'running')).toMatchObject({ status: 'failed' });
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
