import { join } from 'node:path';

import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { createInboxExtension } from '../src/extensions/inbox/inbox.js';
import type { InboxEnvelope } from '../src/inbox/envelope.js';
import { inboxMessageType } from '../src/inbox/receiptDecision.js';
import { writeRecord } from '../src/record.js';
import { ensureTauDirectory } from '../src/tauDirectory.js';
import { createTemporaryRepository } from './gitRepository.js';
import { createHcFake } from './hcFake.js';
import type { HcFake } from './hcFake.js';
import { createPiSession, shutdownSession } from './piSession.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

vi.setConfig({ testTimeout: 30_000 });

const terminal = 't7';
const messageId = '22222222-2222-4222-8222-222222222222';

afterEach(() => {
  vi.unstubAllEnvs();
});

const terminalReply = (labels: Record<string, string>): string =>
  JSON.stringify({ address: terminal, state: 'live', labels });

const isInboxMessage = (entry: { type: string; customType?: string }): boolean =>
  entry.type === 'custom_message' && entry.customType === inboxMessageType;

const receivedMessages = (session: {
  sessionManager: { getEntries: () => { type: string; customType?: string }[] };
}) => session.sessionManager.getEntries().filter(isInboxMessage);

const labelCommands = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments);

const removesMessageLabel = (fake: HcFake): boolean =>
  labelCommands(fake).some((call) => call.at(-1) === `tau.inbox.${messageId}=`);

const queuedEnvelope = async (root: string, targetSessionId: string): Promise<string> => {
  const directory = await ensureTauDirectory(root, 'inbox');

  const envelope: InboxEnvelope = {
    version: 1,
    messageId,
    targetTerminal: terminal,
    targetSessionId,
    family: 'handover',
    text: 'Integration handover\n',
  };

  const path = join(directory, `${messageId}.json`);

  await writeRecord(path, envelope);

  return path;
};

const startSession = async (
  onTestFinished: Parameters<typeof createPiSession>[0],
  options: {
    directory: string;
    agentDirectory: string;
    sessionManager: SessionManager;
    fake: HcFake;
    provider: ReturnType<typeof fauxProvider>;
  },
) => {
  const created = await createPiSession(onTestFinished, {
    cwd: options.directory,
    agentDirectory: options.agentDirectory,
    providers: [options.provider],
    sessionManager: options.sessionManager,
    extensionFactories: [
      createInboxExtension({
        exec: options.fake.exec,
        connect: options.fake.connect,
        subscribe: options.fake.subscribe,
        cwd: options.directory,
      }),
    ],
  });

  if (created.extensionsResult.errors.length > 0) {
    throw new Error(
      `Extensions failed to load: ${JSON.stringify(created.extensionsResult.errors)}`,
    );
  }

  await created.session.bindExtensions({});

  return created.session;
};

it('delivers once, then reopens the saved session without a second message', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-integration-');
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const provider = fauxProvider();

  fake.reply('get', terminalReply({}));
  fake.reply('label', terminalReply({}));

  vi.stubEnv('HC_TERMINAL_ID', terminal);

  const sessionDirectory = join(directory, 'sessions');

  const first = await startSession(onTestFinished, {
    directory,
    agentDirectory: join(directory, 'agent'),
    sessionManager: SessionManager.create(directory, sessionDirectory),
    fake,
    provider,
  });

  const targetSessionId = first.sessionManager.getSessionId();
  const path = await queuedEnvelope(root, targetSessionId);

  fake.reply(
    'get',
    terminalReply({
      'tau.inbox': `${targetSessionId}:9999999999999`,
      [`tau.inbox.${messageId}`]: path,
    }),
  );

  provider.setResponses([fauxAssistantMessage('acknowledged')]);

  const settled = Promise.withResolvers<undefined>();

  first.subscribe((event) => {
    if (event.type === 'agent_settled') {
      settled.resolve(undefined);
    }
  });

  fake.ready();

  await settled.promise;

  expect(receivedMessages(first)).toHaveLength(1);

  const sessionFile = first.sessionManager.getSessionFile();

  if (sessionFile === undefined) {
    throw new Error('The first session saved no file.');
  }

  await shutdownSession(first);

  const second = await startSession(onTestFinished, {
    directory,
    agentDirectory: join(directory, 'agent'),
    sessionManager: SessionManager.open(sessionFile, sessionDirectory),
    fake,
    provider,
  });

  fake.ready();

  await vi.waitFor(() => {
    expect(labelCommands(fake).at(-1)).toEqual([
      'label',
      '--json',
      '--',
      terminal,
      `tau.inbox.${messageId}=`,
    ]);
  });

  expect(receivedMessages(second)).toHaveLength(1);
});

const getCalls = (fake: HcFake): number =>
  fake.calls.filter((call) => call.commandArguments[0] === 'get').length;

it('keeps a nextTurn label until a later run saves the entry', async ({ onTestFinished }) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-nextturn-');
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const provider = fauxProvider();

  fake.reply('get', terminalReply({}));
  fake.reply('label', terminalReply({}));

  vi.stubEnv('HC_TERMINAL_ID', terminal);

  const sessionDirectory = join(directory, 'sessions');

  const created = await createPiSession(onTestFinished, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [provider],
    sessionManager: SessionManager.create(directory, sessionDirectory),
    extensionFactories: [
      createInboxExtension({
        exec: fake.exec,
        connect: fake.connect,
        subscribe: fake.subscribe,
        cwd: directory,
        createWake: (pi) => (_context, message) => {
          pi.sendMessage(message, { deliverAs: 'nextTurn' });
        },
      }),
    ],
  });

  if (created.extensionsResult.errors.length > 0) {
    throw new Error(
      `Extensions failed to load: ${JSON.stringify(created.extensionsResult.errors)}`,
    );
  }

  await created.session.bindExtensions({});

  const targetSessionId = created.session.sessionManager.getSessionId();
  const path = await queuedEnvelope(root, targetSessionId);

  fake.reply(
    'get',
    terminalReply({
      'tau.inbox': `${targetSessionId}:9999999999999`,
      [`tau.inbox.${messageId}`]: path,
    }),
  );

  provider.setResponses([fauxAssistantMessage('continued')]);

  const settled = Promise.withResolvers<undefined>();

  created.session.subscribe((event) => {
    if (event.type === 'agent_settled') {
      settled.resolve(undefined);
    }
  });

  fake.ready();

  await vi.waitFor(() => {
    expect(getCalls(fake)).toBe(2);
  });

  expect(receivedMessages(created.session)).toHaveLength(0);
  expect(removesMessageLabel(fake)).toBe(false);

  await created.session.prompt('continue');
  await settled.promise;

  await vi.waitFor(() => {
    expect(receivedMessages(created.session)).toHaveLength(1);
  });

  await vi.waitFor(() => {
    expect(removesMessageLabel(fake)).toBe(true);
  });
});

it('shows a message queued at startup once only after startup finishes', async ({
  onTestFinished,
}) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-inbox-startup-');
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const provider = fauxProvider();
  const held = Promise.withResolvers<undefined>();

  fake.reply('get', terminalReply({}));
  fake.reply('label', terminalReply({}));

  vi.stubEnv('HC_TERMINAL_ID', terminal);

  const created = await createPiSession(onTestFinished, {
    cwd: directory,
    agentDirectory: join(directory, 'agent'),
    providers: [provider],
    sessionManager: SessionManager.create(directory, join(directory, 'sessions')),
    extensionFactories: [
      createInboxExtension({
        exec: fake.exec,
        connect: fake.connect,
        subscribe: fake.subscribe,
        cwd: directory,
      }),
      (pi) => {
        pi.on('session_start', () => held.promise);
      },
    ],
  });

  if (created.extensionsResult.errors.length > 0) {
    throw new Error(
      `Extensions failed to load: ${JSON.stringify(created.extensionsResult.errors)}`,
    );
  }

  const targetSessionId = created.session.sessionManager.getSessionId();
  const path = await queuedEnvelope(root, targetSessionId);

  fake.reply(
    'get',
    terminalReply({
      'tau.inbox': `${targetSessionId}:9999999999999`,
      [`tau.inbox.${messageId}`]: path,
    }),
  );

  provider.setResponses([fauxAssistantMessage('acknowledged')]);

  const settled = Promise.withResolvers<undefined>();

  created.session.subscribe((event) => {
    if (event.type === 'agent_settled') {
      settled.resolve(undefined);
    }
  });

  const binding = created.session.bindExtensions({});

  await vi.waitFor(() => {
    expect(fake.subscribeCalls.length).toBeGreaterThan(0);
  });

  fake.ready();

  await vi.waitFor(() => {
    expect(getCalls(fake)).toBeGreaterThanOrEqual(1);
  });

  expect(receivedMessages(created.session)).toHaveLength(0);

  held.resolve(undefined);
  await binding;
  await settled.promise;

  expect(receivedMessages(created.session)).toHaveLength(1);
});
