import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import type { HcFake } from '../../../tests/hcFake.js';
import { startHandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import type { HandoverReceiver } from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { readLiveLockHolder, withFileLock } from '../../fileLock/fileLock.js';
import { ownerJson } from '../../fileLock/fixtures/fileLockHarness.js';
import type { HcRuntime } from '../../hc/hc.js';
import { createAnswerTracker } from './answer.js';
import { readArchitectOwner } from './fixtures/toolHarness.js';
import { architectLockPath } from './lock.js';
import { failOpenLiveAsks } from './open/openLiveAsks.js';
import {
  askRecordDirectory,
  askRecordPath,
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
  const owner = await readArchitectOwner(root);

  expect(holder?.pid).toBe(process.pid);
  expect(holder?.checkout).toBe(root);
  expect(holder?.terminal).toBe('t-architect');
  expect(holder?.token).toMatch(/^[0-9a-f-]{36}$/);
  expect(holder?.token).toBe(owner?.lockToken);

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    createAnswerTracker(),
  );

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});

it('an ask session records ask mode', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);
  vi.stubEnv('TAU_ARCHITECT_ASK', '/sessions/ask.json');

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  expect((await readArchitectOwner(root))?.mode).toBe('ask');

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    createAnswerTracker(),
  );
});

it('an empty ask path records visible mode', async ({ onTestFinished }) => {
  stubArchitect(onTestFinished);
  vi.stubEnv('TAU_ARCHITECT_ASK', '');

  const root = await createTemporaryRepository(onTestFinished);
  const { context } = sessionContext(root);
  const session = await startArchitectSession(context, createHeldLockToken());

  expect((await readArchitectOwner(root))?.mode).toBe('visible');

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    createAnswerTracker(),
  );
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

  await endArchitectSession(
    hiddenSession(root, notify),
    hcRuntime(createHcFake()),
    createAnswerTracker(),
  );

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

  await endArchitectSession(
    hiddenSession(root, notify),
    hcRuntime(createHcFake()),
    createAnswerTracker(),
  );

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
  await endArchitectSession(session, hcRuntime(hc), createAnswerTracker());

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

  await endArchitectSession(session, hcRuntime(hc), createAnswerTracker());

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
  expect((await readArchitectOwner(root))?.lockToken).toBe(held.current());

  resume.resolve(undefined);

  const session = await starting;

  expect(session).toBeDefined();

  await endArchitectSession(
    session as NonNullable<typeof session>,
    hcRuntime(createHcFake()),
    createAnswerTracker(),
  );

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

it('ending a visible architect does not note an ask that is already closed', async ({
  onTestFinished,
}) => {
  const { root, session } = await visibleArchitect(onTestFinished);
  const hc = createHcFake();
  const sockets = temporaryDirectory(onTestFinished, 'tau-architect-closed-');

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

  await writeAskRecord(root, liveAsk('answered', 'answered'));
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');
  await endArchitectSession(session, hcRuntime(hc), createAnswerTracker());
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  expect(lead.savedRecords()).toEqual([]);
  expect(await readAskRecord(root, liveIds.answered)).toMatchObject({ status: 'answered' });
});

const holdAskLock = async (
  cleanup: (cleanup: () => Promise<void> | void) => void,
  root: string,
  askId: string,
) => {
  const held = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  const holding = withFileLock(
    {
      lockPath: `${askRecordPath(root, askId)}.lock`,
      checkout: root,
      signal: undefined,
      pollMilliseconds: 10,
      cancelled: () => new Error('Waiting for the ask lock was cancelled.'),
      onWaiting: () => undefined,
    },
    async () => {
      held.resolve(undefined);
      await release.promise;
    },
  );

  await held.promise;

  cleanup(async () => {
    release.resolve(undefined);
    await holding;
  });

  return {
    release: () => {
      release.resolve(undefined);
    },
    holding,
  };
};

const leadTerminal = (hc: HcFake, lead: HandoverReceiver): void => {
  hc.replyGet(
    't-lead',
    JSON.stringify({
      address: 't-lead',
      state: 'live',
      labels: { 'tau.inbox': `rpc1:${lead.path}` },
    }),
  );
};

it('ending does not note an ask that closes after the scan', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();

  const lead = await startHandoverReceiver(
    onTestFinished,
    temporaryDirectory(onTestFinished, 'tau-architect-late-close-'),
    't-lead',
    { sessionId: 'session-lead' },
  );

  leadTerminal(hc, lead);
  await writeAskRecord(root, liveAsk('open', 'unknown'));

  const lock = await holdAskLock(onTestFinished, root, liveIds.open);
  const waiting = Promise.withResolvers<undefined>();
  const warnings: string[] = [];

  const closing = failOpenLiveAsks(
    { root, sessionId: 'session-architect' },
    hcRuntime(hc),
    (message) => warnings.push(message),
    {
      onWaiting: () => {
        waiting.resolve(undefined);
      },
    },
  );

  await waiting.promise;
  await writeAskRecord(root, liveAsk('open', 'answered'));
  lock.release();
  await closing;
  await lock.holding;

  expect(lead.savedRecords()).toEqual([]);
  expect(warnings).toEqual([]);
  expect(await readAskRecord(root, liveIds.open)).toMatchObject({ status: 'answered' });
});

it('ending does not note an ask that disappears after the scan', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();

  const lead = await startHandoverReceiver(
    onTestFinished,
    temporaryDirectory(onTestFinished, 'tau-architect-late-delete-'),
    't-lead',
    { sessionId: 'session-lead' },
  );

  leadTerminal(hc, lead);
  await writeAskRecord(root, liveAsk('open', 'unknown'));

  const lock = await holdAskLock(onTestFinished, root, liveIds.open);
  const waiting = Promise.withResolvers<undefined>();
  const warnings: string[] = [];

  const closing = failOpenLiveAsks(
    { root, sessionId: 'session-architect' },
    hcRuntime(hc),
    (message) => warnings.push(message),
    {
      onWaiting: () => {
        waiting.resolve(undefined);
      },
    },
  );

  await waiting.promise;
  await rm(askRecordPath(root, liveIds.open), { force: true });
  lock.release();
  await closing;
  await lock.holding;

  expect(lead.savedRecords()).toEqual([]);
  expect(warnings).toEqual([]);
  await expect(readAskRecord(root, liveIds.open)).resolves.toBeUndefined();
});
