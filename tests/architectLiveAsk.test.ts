import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished, vi } from 'vitest';

import architectExtension from '../src/extensions/architect/architect.js';
import { acceptArchitectAsk } from '../src/extensions/architect/askAcceptance.js';
import { architectLockPath } from '../src/extensions/architect/lock.js';
import {
  askRecordDirectory,
  readArchitectRecord,
  readAskRecord,
  readAskRecords,
  writeArchitectRecord,
} from '../src/extensions/architect/record.js';
import {
  createHeldLockToken,
  endArchitectSession,
  startArchitectSession,
} from '../src/extensions/architect/session.js';
import { createArchitectTool } from '../src/extensions/architect/tool.js';
import { createInboxExtension } from '../src/extensions/inbox/inbox.js';
import { readLiveLockHolder } from '../src/fileLock/fileLock.js';
import { acceptChecks, sendInboxMessage } from '../src/inbox/inbox.js';
import type { AcceptCheck } from '../src/inbox/inbox.js';
import { fakeExtensionApi } from './extensionApi.js';
import { createTemporaryRepository } from './gitRepository.js';
import { createHcFake } from './hcFake.js';
import type { HcFake } from './hcFake.js';
import { forgetAcceptCheck, startHandoverReceiver } from './inboxReceiverHarness.js';
import type { HandoverReceiver } from './inboxReceiverHarness.js';
import { temporaryTauConfig } from './tauConfigHarness.js';

type FakeApi = ReturnType<typeof fakeExtensionApi>;

const socketRoot = (): string => {
  const root = mkdtempSync('/tmp/tau-live-ask-');

  chmodSync(root, 0o700);

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
};

const stubLead = (): void => {
  const config = temporaryTauConfig(onTestFinished, 'tau-architect-live-ask-');

  config.writeUser({ roles: { architect: { model: 'a/architect' } } });
  vi.stubEnv('PI_CODING_AGENT_DIR', config.location.agentDirectory);
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
};

const toolContext = (root: string, sessionId: string): ExtensionToolContext =>
  ({
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    isProjectTrusted: () => true,
    modelRegistry: {},
    sessionManager: { getSessionId: () => sessionId },
  }) as unknown as ExtensionToolContext;

const architectContext = (root: string): ExtensionContext =>
  ({
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    shutdown: vi.fn<() => void>(),
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionFile: () => join(root, 'architect-session.jsonl'),
      getSessionId: () => 'session-architect',
    },
  }) as unknown as ExtensionContext;

const runHandlers = async (fake: FakeApi, name: string, context: ExtensionContext) => {
  for (const handler of fake.handlers.get(name) ?? []) {
    await handler({ reason: 'startup' } as never, context);
  }
};

const startVisibleArchitect = async (root: string, hc: HcFake) => {
  const fake = fakeExtensionApi({ exec: hc.exec });
  const context = architectContext(root);

  vi.stubEnv('TAU_ROLE', 'architect');
  vi.stubEnv('TAU_ARCHITECT_ASK', '');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');
  architectExtension(fake.pi);
  await runHandlers(fake, 'session_start', context);
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  onTestFinished(async () => {
    await runHandlers(fake, 'session_shutdown', context);
    forgetAcceptCheck('architect-ask');
  });

  const check = acceptChecks()['architect-ask'];

  if (check === undefined) {
    throw new Error('The visible architect registered no architect-ask check.');
  }

  return { fake, context, check };
};

const startArchitectInbox = (check: AcceptCheck): Promise<HandoverReceiver> =>
  startHandoverReceiver(onTestFinished, socketRoot(), 't-architect', {
    sessionId: 'session-architect',
    accepts: { handover: (_request, save) => save(), 'architect-ask': check },
  });

const replyTerminal = (hc: HcFake, address: string, path: string): void => {
  hc.replyGet(
    address,
    JSON.stringify({ address, name: null, state: 'live', labels: { 'tau.inbox': `rpc1:${path}` } }),
  );
};

const savedTexts = async (receiver: HandoverReceiver): Promise<string[]> => {
  const directory = join(dirname(dirname(receiver.path)), 'records', receiver.sessionId);
  const names = await readdir(directory).catch(() => []);

  return Promise.all(
    names.map(async (name) => {
      const saved = JSON.parse(await readFile(join(directory, name), 'utf8')) as {
        payload: { text: string };
      };

      return saved.payload.text;
    }),
  );
};

const askLiveArchitect = async (root: string, hc: HcFake) => {
  const { fake, check } = await startVisibleArchitect(root, hc);
  const architectInbox = await startArchitectInbox(check);
  const leadSockets = socketRoot();
  const leadSocket = join(leadSockets, 'sockets', 'session-lead.sock');

  replyTerminal(hc, 't-lead', leadSocket);
  replyTerminal(hc, 't-architect', architectInbox.path);

  const asked = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    toolContext(root, 'session-lead'),
  );

  expect(asked.details).toMatchObject({ action: 'ask', status: 'queued', terminal: 't-architect' });

  const [question = ''] = await savedTexts(architectInbox);
  const askId = /^Ask (?<askId>\S+) from the lead/v.exec(question)?.groups?.['askId'] ?? '';

  expect(question).toContain('"Which flag name?"');
  expect(question).toContain(`architect answer and askId ${askId}`);
  expect(asked.details).toMatchObject({ askId });

  await writeFile(join(root, 'answer.md'), 'Use --dry-run.\n');

  const answer = () => {
    const tool = fake.tools.get('architect');

    if (tool === undefined) {
      throw new Error('The visible architect registered no architect tool.');
    }

    vi.stubEnv('HC_TERMINAL_ID', 't-architect');

    return tool.execute(
      'call',
      { action: 'answer', askId, file: 'answer.md' },
      undefined,
      undefined,
      toolContext(root, 'session-architect'),
    );
  };

  return { askId, leadSockets, leadSocket, answer };
};

it('the lead session that asked receives the live architect answer in its inbox', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();

  stubLead();

  const { askId, leadSockets, leadSocket, answer } = await askLiveArchitect(root, hc);
  const lockToken = (await readArchitectRecord(root))?.owner?.lockToken;

  const lead = await startHandoverReceiver(onTestFinished, leadSockets, 't-lead', {
    sessionId: 'session-lead',
  });

  expect(lead.path).toBe(leadSocket);

  const answered = await answer();
  const texts = await savedTexts(lead);

  expect(answered.details).toEqual({ action: 'answer', status: 'queued', askId });
  expect(texts).toHaveLength(1);
  expect(texts[0]?.startsWith(`Answer to ask ${askId}`)).toBe(true);
  expect(texts[0]).toContain('Use --dry-run.');
  expect(await readAskRecord(root, askId)).toMatchObject({ status: 'answered' });
  expect((await readLiveLockHolder(architectLockPath(root)))?.token).toBe(lockToken);
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
});

it('an answer to a lead terminal that started a new session saves nothing and fails', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();

  stubLead();

  const { askId, leadSockets, answer } = await askLiveArchitect(root, hc);

  const newSession = await startHandoverReceiver(onTestFinished, leadSockets, 't-lead', {
    sessionId: 'session-lead-new',
  });

  replyTerminal(hc, 't-lead', newSession.path);

  await expect(answer()).rejects.toThrow(/changed session/);
  await expect(savedTexts(newSession)).resolves.toEqual([]);
  expect(await readAskRecord(root, askId)).toMatchObject({ status: 'failed' });
});

it('an architect-ask is saved only while the architect holds the lock token it names', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();

  stubLead();

  const { fake, context, check } = await startVisibleArchitect(root, hc);
  const inbox = await startArchitectInbox(check);
  const tokenOne = (await readArchitectRecord(root))?.owner?.lockToken ?? '';

  replyTerminal(hc, 't-architect', inbox.path);

  const send = (text: string, lockToken?: string) => {
    const body =
      lockToken === undefined
        ? { family: 'handover', payload: { text } }
        : { family: 'architect-ask', payload: { text, lockToken } };

    return sendInboxMessage({
      hc: { ...hc, cwd: root },
      target: 't-architect',
      sessionId: 'session-architect',
      body,
      refusal: 'Nothing was queued.',
    });
  };

  const refusal = `This architect does not hold lock ${tokenOne} now. It restarted or closed. Call architect ask again. Nothing was queued.`;

  await expect(send('held ask', tokenOne)).resolves.toMatchObject({ status: 'queued' });
  await expect(send('held handover')).resolves.toMatchObject({ status: 'queued' });

  await runHandlers(fake, 'session_shutdown', context);

  await expect(send('closed ask', tokenOne)).rejects.toThrow(refusal);
  await expect(send('closed handover')).resolves.toMatchObject({ status: 'queued' });

  vi.stubEnv('TAU_ROLE', 'architect');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');
  await runHandlers(fake, 'session_start', context);
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  const tokenTwo = (await readArchitectRecord(root))?.owner?.lockToken ?? '';

  expect(tokenTwo).not.toBe(tokenOne);
  await expect(send('restarted ask', tokenOne)).rejects.toThrow(refusal);
  await expect(send('new ask', tokenTwo)).resolves.toMatchObject({ status: 'queued' });
  await expect(send('restarted handover')).resolves.toMatchObject({ status: 'queued' });

  expect((await savedTexts(inbox)).toSorted()).toEqual(
    ['closed handover', 'held ask', 'held handover', 'new ask', 'restarted handover'].toSorted(),
  );
});

it('an architect-ask sent after the record is published but before startup returns is saved', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();
  const held = createHeldLockToken();

  const inbox = await startHandoverReceiver(onTestFinished, socketRoot(), 't-architect', {
    sessionId: 'session-architect',
    accepts: {
      handover: (_request, save) => save(),
      'architect-ask': acceptArchitectAsk(held.current),
    },
  });

  stubLead();
  replyTerminal(hc, 't-architect', inbox.path);
  vi.stubEnv('TAU_ROLE', 'architect');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const published = Promise.withResolvers<undefined>();
  const resume = Promise.withResolvers<undefined>();

  const starting = startArchitectSession(architectContext(root), held, async () => {
    published.resolve(undefined);
    await resume.promise;
  });

  await published.promise;

  const token = held.current() ?? '';

  expect(token).not.toBe('');
  vi.stubEnv('HC_TERMINAL_ID', 't-lead');

  await expect(
    sendInboxMessage({
      hc: { ...hc, cwd: root },
      target: 't-architect',
      sessionId: 'session-architect',
      body: { family: 'architect-ask', payload: { text: 'startup ask', lockToken: token } },
      refusal: 'Nothing was queued.',
    }),
  ).resolves.toMatchObject({ status: 'queued' });

  await expect(savedTexts(inbox)).resolves.toEqual(['startup ask']);

  resume.resolve(undefined);

  const session = await starting;

  expect(session).toBeDefined();

  await endArchitectSession(session as NonNullable<typeof session>, { ...hc, cwd: root });

  expect(held.current()).toBeUndefined();
});

it.for([
  { name: 'a lead session', role: 'lead', askPath: '' },
  { name: 'a hidden ask session', role: 'architect', askPath: '/tmp/tau-ask/ask.json' },
])('$name refuses an architect-ask and saves nothing', async ({ role, askPath }) => {
  const sockets = socketRoot();
  const hc = createHcFake();
  const inbox = fakeExtensionApi();
  const terminal = JSON.stringify({ address: 't-session', name: null, state: 'live', labels: {} });

  forgetAcceptCheck('architect-ask');
  stubLead();
  vi.stubEnv('TAU_ROLE', role);
  vi.stubEnv('TAU_ARCHITECT_ASK', askPath);
  vi.stubEnv('HC_TERMINAL_ID', 't-session');
  architectExtension(fakeExtensionApi().pi);
  hc.reply('label', terminal);
  hc.reply('get', terminal);

  createInboxExtension({
    hc: { ...hc, cwd: sockets },
    socketDirectory: () => join(sockets, 'sockets'),
    inboxDirectory: () => join(sockets, 'records'),
  })(inbox.pi);

  const context = {
    sessionManager: { getSessionId: () => 'session-x', getEntries: () => [] },
    ui: { notify: vi.fn<(message: string) => void>() },
    isIdle: () => true,
    signal: undefined,
  } as unknown as ExtensionContext;

  await runHandlers(inbox, 'session_start', context);

  onTestFinished(async () => {
    await runHandlers(inbox, 'session_shutdown', context);
  });

  vi.stubEnv('HC_TERMINAL_ID', 't-lead');
  replyTerminal(hc, 't-session', join(sockets, 'sockets', 'session-x.sock'));

  await expect(
    sendInboxMessage({
      hc: { ...hc, cwd: sockets },
      target: 't-session',
      sessionId: 'session-x',
      body: { family: 'architect-ask', payload: { text: 'Ask text', lockToken: 'lock-1' } },
      refusal: 'Nothing was queued.',
    }),
  ).rejects.toThrow('This session does not accept architect-ask messages. Nothing was queued.');

  await expect(readdir(join(sockets, 'records'))).rejects.toThrow(/ENOENT/);
});

const recordLiveArchitect = async (
  root: string,
  architectSessionId = 'session-architect',
): Promise<void> => {
  const lockPath = `${architectLockPath(root)}.1`;
  const sessionFile = join(root, 'architect-session.jsonl');

  await mkdir(dirname(lockPath), { recursive: true });

  await writeFile(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      checkout: root,
      startedAt: new Date().toISOString(),
      token: 'live',
    }),
  );

  await writeFile(sessionFile, '');

  await writeArchitectRecord(root, {
    version: 2,
    sessionFile,
    leadTerminal: 't-lead',
    owner: {
      lockToken: 'live',
      mode: 'visible',
      terminal: 't-architect',
      sessionId: architectSessionId,
    },
    updatedAt: new Date().toISOString(),
  });
};

it('a second ask refuses while a hidden ask runs, even with this checkout holding the lock', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();
  const receiver = await startHandoverReceiver(onTestFinished, socketRoot(), 't-ask');

  stubLead();
  await recordLiveArchitect(root);
  await mkdir(askRecordDirectory(root), { recursive: true });

  await writeFile(
    join(askRecordDirectory(root), '0190c1d2-0000-7000-8000-000000000110.json'),
    JSON.stringify({
      version: 2,
      route: 'hidden',
      askId: '0190c1d2-0000-7000-8000-000000000110',
      createdAt: new Date().toISOString(),
      question: 'Earlier question',
      sessionFile: join(root, 'architect-session.jsonl'),
      terminal: 't-ask',
      leadTerminal: 't-lead',
      deadline: Date.now() + 1000,
      status: 'running',
      detail: null,
      answer: null,
    }),
  );

  replyTerminal(hc, 't-ask', receiver.path);

  const asked = await createArchitectTool({ ...hc, cwd: root }).execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    toolContext(root, 'session-lead'),
  );

  const reason = (asked.details as { reason: string }).reason;

  expect(asked.details).toMatchObject({ action: 'ask', status: 'needsOpen' });
  expect(reason).toContain('0190c1d2-0000-7000-8000-000000000110');
  expect(reason).toContain('Wait for it');
  expect(reason).not.toContain('architect open');

  await expect(readAskRecords(root)).resolves.toMatchObject({
    records: [{ askId: '0190c1d2-0000-7000-8000-000000000110', status: 'running' }],
  });

  expect(receiver.savedRecords()).toEqual([]);
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
});

it('ask refuses a changed architect session', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const hc = createHcFake();
  const architect = await startHandoverReceiver(onTestFinished, socketRoot(), 't-architect');

  stubLead();
  await recordLiveArchitect(root, 'recorded-session');
  replyTerminal(hc, 't-lead', '/tmp/tau-lead/session-lead.sock');
  replyTerminal(hc, 't-architect', architect.path);

  const tool = createArchitectTool({ ...hc, cwd: root });

  const asked = tool.execute(
    'call',
    { action: 'ask', question: 'Which flag name?' },
    undefined,
    undefined,
    toolContext(root, 'session-lead'),
  );

  await expect(asked).rejects.toThrow(/changed session/);

  expect(architect.savedRecords()).toEqual([]);
  expect(hc.calls.map((call) => call.commandArguments[0])).not.toContain('run');
});
