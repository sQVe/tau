import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readLiveLockHolder } from '../../fileLock/fileLock.js';
import { ownerJson } from '../../fileLock/fixtures/fileLockHarness.js';
import type { HcRuntime } from '../../hc/hc.js';
import { architectLockPath } from './lock.js';
import {
  askRecordDirectory,
  readArchitectRecord,
  readAskRecord,
  writeAskRecord,
} from './record.js';
import type { HiddenAskRecord, LiveAskRecord } from './record.js';
import { createHeldLockToken, endArchitectSession, startArchitectSession } from './session.js';
import type { ArchitectSession } from './session.js';

const hcRuntime = (hc: HcFake): HcRuntime => ({ ...hc, cwd: process.cwd() });

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

  expect(await startArchitectSession(context, createHeldLockToken())).toBeUndefined();

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

  const session = await startArchitectSession(context, createHeldLockToken());

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

  await endArchitectSession(session as NonNullable<typeof session>, hcRuntime(createHcFake()));

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('an ask session records ask mode', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);
  vi.stubEnv('TAU_ARCHITECT_ASK', '/sessions/ask.json');

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  expect((await readArchitectRecord(root))?.owner?.mode).toBe('ask');

  await endArchitectSession(session as NonNullable<typeof session>, hcRuntime(createHcFake()));
});

it('an empty ask path records visible mode', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);
  vi.stubEnv('TAU_ARCHITECT_ASK', '');

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  expect((await readArchitectRecord(root))?.owner?.mode).toBe('visible');

  await endArchitectSession(session as NonNullable<typeof session>, hcRuntime(createHcFake()));
});

const hiddenIds = {
  running: '0190c1d2-0000-7000-8000-000000000301',
  sent: '0190c1d2-0000-7000-8000-000000000302',
} as const;

const hiddenAsk = (
  name: keyof typeof hiddenIds,
  status: HiddenAskRecord['status'],
): HiddenAskRecord => ({
  version: 2,
  route: 'hidden',
  askId: hiddenIds[name],
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

const liveIds = {
  live: '0190c1d2-0000-7000-8000-000000000303',
  open: '0190c1d2-0000-7000-8000-000000000304',
  answered: '0190c1d2-0000-7000-8000-000000000305',
} as const;

const liveAsk = (name: keyof typeof liveIds, status: LiveAskRecord['status']): LiveAskRecord => ({
  version: 2,
  route: 'live',
  askId: liveIds[name],
  createdAt: '2026-11-17T10:00:00.000Z',
  question: 'Which flag name?',
  leadTerminal: 't-lead',
  leadSessionId: 'session-lead',
  architectTerminal: 't-architect',
  architectSessionId: 'session-architect',
  architectLockToken: 'live',
  status,
  detail: null,
  answer: null,
});

const hiddenSession = (
  root: string,
  notify: (message: string, level?: string) => void,
): ArchitectSession => ({
  root,
  release: () => Promise.resolve(),
  ui: { notify },
  owner: { lockToken: 'live', mode: 'ask', terminal: 't-ask', sessionId: 'session-architect' },
  held: createHeldLockToken(),
});

it('ending fails only running hidden asks', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeAskRecord(root, hiddenAsk('running', 'running'));
  await writeAskRecord(root, hiddenAsk('sent', 'sent'));
  await writeAskRecord(root, liveAsk('live', 'sending'));

  const notify = vi.fn<(message: string, level?: string) => void>();

  await endArchitectSession(hiddenSession(root, notify), hcRuntime(createHcFake()));

  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'failed' });
  expect(await readAskRecord(root, hiddenIds.sent)).toMatchObject({ status: 'sent' });
  expect(await readAskRecord(root, liveIds.live)).toMatchObject({ status: 'sending' });
});

it('ending reports a bad ask file and still fails the running ask', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const notify = vi.fn<(message: string, level?: string) => void>();

  await writeAskRecord(root, hiddenAsk('running', 'running'));
  await mkdir(askRecordDirectory(root), { recursive: true });
  await writeFile(join(askRecordDirectory(root), 'malformed.json'), '{"version":2');

  await endArchitectSession(hiddenSession(root, notify), hcRuntime(createHcFake()));

  expect(notify).toHaveBeenCalledWith(expect.stringContaining('Malformed ask record'), 'warning');
  expect(await readAskRecord(root, hiddenIds.running)).toMatchObject({ status: 'failed' });
});

it('a non-architect session takes no lock', async ({ onTestFinished }) => {
  vi.stubEnv('TAU_ROLE', 'lead');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);

  expect(await startArchitectSession(context, createHeldLockToken())).toBeUndefined();
  expect(await readArchitectRecord(root)).toBeUndefined();
});

const visibleArchitect = async (cleanup: (cleanup: () => void) => void) => {
  stubArchitect(cleanup);

  const root = await createTemporaryRepository(cleanup);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  if (session === undefined) {
    throw new Error('The architect did not start.');
  }

  return { root, session };
};

it('ending a visible architect fails its open live ask and tells the lead to ask again', async ({
  onTestFinished,
}) => {
  const { root, session } = await visibleArchitect(onTestFinished);
  const hc = createHcFake();
  const sockets = temporaryDirectory(onTestFinished, 'tau-architect-close-');

  const lead = await startHandoverReceiver(onTestFinished, sockets, 't-lead', {
    sessionId: 'session-lead',
  });

  hc.replyGet(
    't-lead',
    JSON.stringify({
      address: 't-lead',
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${lead.path}` },
    }),
  );

  await writeAskRecord(root, liveAsk('open', 'queued'));
  await writeAskRecord(root, liveAsk('answered', 'answered'));
  await endArchitectSession(session, hcRuntime(hc));

  const directory = join(sockets, 'records', 'session-lead');
  const names = await readdir(directory);

  const texts = await Promise.all(
    names.map(async (name) => {
      const saved = JSON.parse(await readFile(join(directory, name), 'utf8')) as {
        payload: { text: string };
      };

      return saved.payload.text;
    }),
  );

  expect(texts).toEqual([
    `Ask ${liveIds.open} got no answer: the architect closed. Call architect ask again.`,
  ]);

  expect(await readAskRecord(root, liveIds.open)).toMatchObject({
    status: 'failed',
    detail: 'The architect closed before it answered.',
  });

  expect(await readAskRecord(root, liveIds.answered)).toMatchObject({ status: 'answered' });
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('ending a visible architect releases its lock when the close note cannot be sent', async ({
  onTestFinished,
}) => {
  const { root, session } = await visibleArchitect(onTestFinished);
  const hc = createHcFake();

  hc.fail('get', 'no such terminal', 1);
  await writeAskRecord(root, liveAsk('open', 'unknown'));
  const notify = session.ui.notify as unknown as Mock;

  await endArchitectSession(session, hcRuntime(hc));

  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining(`The lead got no close note for ask ${liveIds.open}:`),
    'warning',
  );

  expect(await readAskRecord(root, liveIds.open)).toMatchObject({ status: 'failed' });
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('holds the lock token from the lock, before the record and startup return', async ({
  onTestFinished,
}) => {
  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);
  const held = createHeldLockToken();
  const published = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();

  const starting = startArchitectSession(context, held, async () => {
    published.resolve(undefined);
    await resume.promise;
  });

  await published.promise;

  expect(held.current()).toMatch(/^[0-9a-f-]{36}$/);
  expect((await readArchitectRecord(root))?.owner?.lockToken).toBe(held.current());

  resume.resolve(undefined);

  const session = await starting;

  expect(session).toBeDefined();

  await endArchitectSession(session as NonNullable<typeof session>, hcRuntime(createHcFake()));

  expect(held.current()).toBeUndefined();
});

it('clears the held token when startup fails after the lock', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);
  const held = createHeldLockToken();

  const session = await startArchitectSession(context, held, () =>
    Promise.reject(new Error('publish failed')),
  );

  expect(session).toBeUndefined();
  expect(held.current()).toBeUndefined();
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
