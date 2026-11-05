import { access, chmod, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { expect, it, onTestFinished as registerCleanup, vi } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { createHcFake } from '../../tests/hcFake.js';
import type { HcFake } from '../../tests/hcFake.js';
import type { Exec } from '../command.js';
import type { HcRuntime } from '../hc/hc.js';
import { serializeRecord, writeRecord } from '../record.js';
import { ensureTauDirectory } from '../tauDirectory.js';
import { createWake } from '../wake/wake.js';
import type { Wake, WakeMessage } from '../wake/wake.js';
import { envelopeByteLimit } from './envelope.js';
import type { InboxEnvelope } from './envelope.js';
import { inboxMessageType } from './receiptDecision.js';
import { createReceiptStore } from './receipts.js';
import { createReceiver } from './receive.js';
import type { InboxScanContext, ReceiverFence, StartupGate } from './receive.js';

interface SessionEntry {
  type: string;
  customType?: string;
  details?: unknown;
}

interface Harness {
  fake: HcFake;
  messages: WakeMessage[];
  notifications: string[];
  entries: SessionEntry[];
  context: InboxScanContext;
  gate: StartupGate;
  release: () => void;
  waiting: () => number;
  receiver: (overrides?: {
    wake?: Wake;
    receipts?: ReturnType<typeof createReceiptStore>;
    fence?: ReceiverFence;
  }) => {
    scan: (context: InboxScanContext) => Promise<void>;
  };
}

const terminal = 't7';

const fenceStub = (overrides: Partial<ReceiverFence> = {}): ReceiverFence => ({
  observe: () => undefined,
  isCurrent: () => true,
  confirmOwnership: () => Promise.resolve(true),
  ...overrides,
});

const sessionId = 'session-1';
const messageId = '11111111-1111-4111-8111-111111111111';

const runtimeOf = (fake: HcFake): HcRuntime => ({
  exec: fake.exec,
  connect: fake.connect,
  cwd: '/repository',
});

const terminalReply = (labels: Record<string, string>): string =>
  JSON.stringify({ address: terminal, state: 'live', labels });

const labelArguments = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments);

const currentEnvelope = (): InboxEnvelope => ({
  version: 2,
  messageId,
  targetTerminal: terminal,
  targetSessionId: sessionId,
  family: 'handover',
  text: 'Handover body\n',
});

const createGate = () => {
  let open = false;
  const waiters: (() => void)[] = [];

  const gate: StartupGate = {
    whenReady: () =>
      open
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push(resolve);
          }),
    isReady: () => open,
  };

  const release = (): void => {
    open = true;

    for (const resolve of waiters.splice(0)) {
      resolve();
    }
  };

  return { gate, release, waiting: () => waiters.length };
};

const receiptEntry = (): SessionEntry => ({
  type: 'custom_message',
  customType: inboxMessageType,
  details: { version: 1, messageId, sessionId, family: 'handover' },
});

const writeCurrentEnvelope = async (directory: string): Promise<string> => {
  const text = serializeRecord(currentEnvelope());

  if (Buffer.byteLength(text, 'utf8') > envelopeByteLimit) {
    throw new Error('fixture envelope is too large');
  }

  const path = join(directory, `${messageId}.json`);

  await writeRecord(path, currentEnvelope());

  return path;
};

const createHarness = (path: string): Harness => {
  const fake = createHcFake();

  fake.reply(
    'get',
    terminalReply({
      'tau.inbox.': '/not-an-envelope',
      'tau.inbox': `${sessionId}:9999999999999`,
      [`tau.inbox.${messageId}`]: path,
      'tau.report.example': '/not-an-envelope',
    }),
  );

  fake.reply('label', terminalReply({}));

  const messages: WakeMessage[] = [];
  const notifications: string[] = [];
  const entries: SessionEntry[] = [];
  const { gate, release, waiting } = createGate();

  const wake: Wake = (_context, message) => {
    messages.push(message);
  };

  const context = {
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => undefined },
    isIdle: () => true,
    signal: undefined,
  } as unknown as InboxScanContext;

  const receiver = (
    overrides: {
      wake?: Wake;
      receipts?: ReturnType<typeof createReceiptStore>;
      fence?: ReceiverFence;
    } = {},
  ) =>
    createReceiver({
      hc: runtimeOf(fake),
      terminal,
      sessionId,
      gate,
      wake: overrides.wake ?? wake,
      notify: (_context, message) => notifications.push(message),
      receipts: overrides.receipts ?? createReceiptStore(sessionId),
      fence: overrides.fence ?? fenceStub(),
    });

  return { fake, messages, notifications, entries, context, gate, release, waiting, receiver };
};

it('shows a queued message once and removes its label only after the receipt is saved', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);

  const pending = harness.receiver().scan(harness.context);

  await Promise.resolve();
  await Promise.resolve();

  expect(harness.messages).toEqual([]);
  expect(labelArguments(harness.fake)).toEqual([]);

  harness.release();
  await pending;

  expect(harness.messages).toHaveLength(1);
  expect(harness.messages[0]?.content).toBe('Handover body\n');
  expect(harness.messages[0]?.display).toBe(true);
  expect(harness.notifications).toEqual([]);

  expect(harness.messages[0]?.details).toEqual({
    version: 2,
    messageId,
    sessionId,
    family: 'handover',
  });

  expect(labelArguments(harness.fake)).toEqual([]);

  harness.entries.push(receiptEntry());

  await harness.receiver().scan(harness.context);

  expect(harness.messages).toHaveLength(1);

  expect(labelArguments(harness.fake)).toEqual([
    ['label', '--json', '--', terminal, `tau.inbox.${messageId}=`],
  ]);

  await harness.receiver().scan(harness.context);

  expect(harness.messages).toHaveLength(1);
});

it('keeps an envelope for another session queued without showing it', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const envelope = { ...currentEnvelope(), targetSessionId: 'other-session' };
  const path = join(directory, `${messageId}.json`);

  await writeRecord(path, envelope);

  const harness = createHarness(path);

  harness.release();
  await harness.receiver().scan(harness.context);

  expect(harness.messages).toEqual([]);
  expect(harness.notifications).toEqual([]);
  expect(labelArguments(harness.fake)).toEqual([]);
});

it.each([
  {
    name: 'a path outside the roots',
    path: (_directory: string) =>
      '/not-a-repository/.tau/inbox/11111111-1111-4111-8111-111111111111.json',
    write: undefined,
  },
  {
    name: 'an envelope over the size limit',
    path: (directory: string) => join(directory, `${messageId}.json`),
    write: async (directory: string) => {
      const path = join(directory, `${messageId}.json`);

      await writeFile(
        path,
        JSON.stringify({ ...currentEnvelope(), text: 'x'.repeat(envelopeByteLimit) }),
      );
    },
  },
  {
    name: 'an envelope for another target terminal',
    path: (directory: string) => join(directory, `${messageId}.json`),
    write: async (directory: string) => {
      await writeRecord(join(directory, `${messageId}.json`), {
        ...currentEnvelope(),
        targetTerminal: 't9',
      });
    },
  },
  {
    name: 'an unknown envelope version',
    path: (directory: string) => join(directory, `${messageId}.json`),
    write: async (directory: string) => {
      await writeFile(
        join(directory, `${messageId}.json`),
        JSON.stringify({ ...currentEnvelope(), version: 3 }),
      );
    },
  },
] as const)('refuses $name with a notice and no delivery', async ({ path, write }) => {
  const root = await createTemporaryRepository(registerCleanup);
  const directory = await ensureTauDirectory(root, 'inbox');

  await write?.(directory);

  const harness = createHarness(path(directory));

  harness.release();
  await harness.receiver().scan(harness.context);

  expect(harness.messages).toEqual([]);
  expect(harness.notifications).toHaveLength(1);
  expect(labelArguments(harness.fake)).toEqual([]);
});

it('refuses a symlinked envelope with a notice and no delivery', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const target = await writeCurrentEnvelope(directory);
  const path = join(directory, 'linked.json');

  await symlink(target, path);

  const harness = createHarness(path);

  harness.release();
  await harness.receiver().scan(harness.context);

  expect(harness.messages).toEqual([]);
  expect(harness.notifications).toHaveLength(1);
  expect(labelArguments(harness.fake)).toEqual([]);
});

it('wakes an idle session and steers a mid-turn one through wake', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);

  const sent: { message: WakeMessage; options: unknown }[] = [];

  const pi = {
    on: () => undefined,
    sendMessage: (message: WakeMessage, options: unknown) => {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  const wake = createWake(pi);

  const harness = createHarness(path);

  harness.release();

  const idleReceiver = createReceiver({
    hc: runtimeOf(harness.fake),
    terminal,
    sessionId,
    gate: harness.gate,
    wake,
    notify: () => undefined,
    receipts: createReceiptStore(sessionId),
    fence: fenceStub(),
  });

  const idleContext = { ...harness.context, isIdle: () => true } as InboxScanContext;

  await idleReceiver.scan(idleContext);

  expect(sent[0]?.options).toEqual({ triggerTurn: true });

  const busyReceiver = createReceiver({
    hc: runtimeOf(harness.fake),
    terminal,
    sessionId,
    gate: harness.gate,
    wake,
    notify: () => undefined,
    receipts: createReceiptStore(sessionId),
    fence: fenceStub(),
  });

  const busyContext = {
    ...harness.context,
    isIdle: () => false,
    signal: new AbortController().signal,
  } as InboxScanContext;

  await busyReceiver.scan(busyContext);

  expect(sent[1]?.options).toEqual({ deliverAs: 'steer', triggerTurn: true });
});

it('keeps a nextTurn label and retries a failed removal without another wake', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);

  harness.release();

  const receiver = harness.receiver();

  await receiver.scan(harness.context);

  expect(harness.messages).toHaveLength(1);
  expect(labelArguments(harness.fake)).toEqual([]);

  await receiver.scan(harness.context);

  expect(harness.messages).toHaveLength(1);
  expect(labelArguments(harness.fake)).toEqual([]);

  harness.entries.push(receiptEntry());
  harness.fake.fail('label', 'label failed', 1);

  await receiver.scan(harness.context);
  await receiver.scan(harness.context);

  expect(harness.messages).toHaveLength(1);
  expect(labelArguments(harness.fake)).toHaveLength(2);
});

it('does not wake when this session lost the lease', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);

  harness.release();

  await harness
    .receiver({ fence: fenceStub({ confirmOwnership: () => Promise.resolve(false) }) })
    .scan(harness.context);

  expect(harness.messages).toEqual([]);
  expect(labelArguments(harness.fake)).toEqual([]);
});

it('does not wake or remove labels when the generation became inactive', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);

  harness.release();

  await harness.receiver({ fence: fenceStub({ isCurrent: () => false }) }).scan(harness.context);

  expect(harness.messages).toEqual([]);
  expect(labelArguments(harness.fake)).toEqual([]);
});

it('touches no label when the generation ends during the label read', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);
  let current = true;

  const exec: Exec = async (command, commandArguments, options) => {
    const result = await harness.fake.exec(command, commandArguments, options);

    current = false;

    return result;
  };

  harness.release();
  harness.entries.push(receiptEntry());

  await createReceiver({
    hc: { ...runtimeOf(harness.fake), exec },
    terminal,
    sessionId,
    gate: harness.gate,
    wake: () => undefined,
    notify: (_context, message) => harness.notifications.push(message),
    receipts: createReceiptStore(sessionId),
    fence: fenceStub({ isCurrent: () => current }),
  }).scan(harness.context);

  expect(labelArguments(harness.fake)).toEqual([]);
});

it('shows no notice when the generation ends during the envelope read', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = join(directory, `${messageId}.json`);

  await writeRecord(path, { ...currentEnvelope(), targetTerminal: 't9' });

  const harness = createHarness(path);
  let checks = 0;

  const isCurrent = (): boolean => {
    checks += 1;

    return checks === 1;
  };

  harness.release();
  await harness.receiver({ fence: fenceStub({ isCurrent }) }).scan(harness.context);

  expect(harness.notifications).toEqual([]);
});

it('neither wakes nor touches later labels when the generation ends during the startup wait', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);
  const savedMessageId = '22222222-2222-4222-8222-222222222222';
  let current = true;

  harness.fake.reply(
    'get',
    terminalReply({
      'tau.inbox': `${sessionId}:9999999999999`,
      [`tau.inbox.${messageId}`]: path,
      [`tau.inbox.${savedMessageId}`]: join(directory, `${savedMessageId}.json`),
    }),
  );

  harness.entries.push({
    type: 'custom_message',
    customType: inboxMessageType,
    details: { version: 1, messageId: savedMessageId, sessionId, family: 'handover' },
  });

  const pending = harness
    .receiver({ fence: fenceStub({ isCurrent: () => current }) })
    .scan(harness.context);

  await vi.waitFor(() => {
    expect(harness.waiting()).toBe(1);
  });

  current = false;
  harness.release();
  await pending;

  expect(harness.messages).toEqual([]);
  expect(labelArguments(harness.fake)).toEqual([]);
});

it('shows a notice and delivers nothing when the label read fails', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);

  harness.release();
  harness.fake.fail('get', 'hc is down', 1);
  await harness.receiver().scan(harness.context);

  expect(harness.messages).toEqual([]);
  expect(harness.notifications).toHaveLength(1);
});

it('passes the lease it reads to the session', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);
  const observed: (string | undefined)[] = [];

  harness.release();

  await harness
    .receiver({ fence: fenceStub({ observe: (value) => observed.push(value) }) })
    .scan(harness.context);

  expect(observed).toEqual([`${sessionId}:9999999999999`]);
});

it('removes every saved label in one scan', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);
  const savedMessageId = '22222222-2222-4222-8222-222222222222';

  harness.fake.reply(
    'get',
    terminalReply({
      [`tau.inbox.${messageId}`]: path,
      [`tau.inbox.${savedMessageId}`]: join(directory, `${savedMessageId}.json`),
    }),
  );

  harness.entries.push(receiptEntry(), {
    type: 'custom_message',
    customType: inboxMessageType,
    details: { version: 1, messageId: savedMessageId, sessionId, family: 'handover' },
  });

  harness.release();
  await harness.receiver().scan(harness.context);

  expect(labelArguments(harness.fake)).toEqual([
    ['label', '--json', '--', terminal, `tau.inbox.${messageId}=`],
    ['label', '--json', '--', terminal, `tau.inbox.${savedMessageId}=`],
  ]);
});

const fileExists = async (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

it('deletes a delivered envelope after its receipt is saved and its label removed', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);

  harness.release();
  harness.entries.push(receiptEntry());
  await harness.receiver().scan(harness.context);

  expect(labelArguments(harness.fake)).toHaveLength(1);
  expect(await fileExists(path)).toBe(false);
});

it.each([
  {
    name: 'an envelope for another session',
    envelope: { ...currentEnvelope(), targetSessionId: 'other-session' },
  },
  {
    name: 'a refused envelope',
    envelope: { ...currentEnvelope(), targetTerminal: 't9' },
  },
])('keeps $name after removing a saved label', async ({ envelope }) => {
  const root = await createTemporaryRepository(registerCleanup);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = join(directory, `${messageId}.json`);

  await writeRecord(path, envelope);

  const harness = createHarness(path);

  harness.release();
  harness.entries.push(receiptEntry());
  await harness.receiver().scan(harness.context);

  expect(labelArguments(harness.fake)).toHaveLength(1);
  expect(await fileExists(path)).toBe(true);
});

it('keeps the envelope when the label removal fails', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);

  harness.release();
  harness.entries.push(receiptEntry());
  harness.fake.fail('label', 'label failed', 1);
  await harness.receiver().scan(harness.context);

  expect(labelArguments(harness.fake)).toHaveLength(1);
  expect(await fileExists(path)).toBe(true);
});

it('keeps the envelope when the generation ends during the label removal', async ({
  onTestFinished,
}) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);
  let current = true;

  const exec: Exec = async (command, commandArguments, options) => {
    const result = await harness.fake.exec(command, commandArguments, options);

    if (commandArguments[0] === 'label') {
      current = false;
    }

    return result;
  };

  harness.release();
  harness.entries.push(receiptEntry());

  await createReceiver({
    hc: { ...runtimeOf(harness.fake), exec },
    terminal,
    sessionId,
    gate: harness.gate,
    wake: () => undefined,
    notify: (_context, message) => harness.notifications.push(message),
    receipts: createReceiptStore(sessionId),
    fence: fenceStub({ isCurrent: () => current }),
  }).scan(harness.context);

  expect(labelArguments(harness.fake)).toHaveLength(1);
  expect(await fileExists(path)).toBe(true);
});

it('keeps the receipt and the removed label when the delete fails', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = await writeCurrentEnvelope(directory);
  const harness = createHarness(path);
  const receipts = createReceiptStore(sessionId);

  await chmod(directory, 0o500);
  onTestFinished(() => chmod(directory, 0o700));

  harness.release();
  harness.entries.push(receiptEntry());
  await harness.receiver({ receipts }).scan(harness.context);

  expect(labelArguments(harness.fake)).toHaveLength(1);
  expect(receipts.hasReceipt(messageId)).toBe(true);
  expect(harness.notifications).toEqual([]);
  expect(harness.messages).toEqual([]);
  expect(await fileExists(path)).toBe(true);
});
