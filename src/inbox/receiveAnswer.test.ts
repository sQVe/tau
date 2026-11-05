import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { createHcFake } from '../../tests/hcFake.js';
import type { HcFake } from '../../tests/hcFake.js';
import { writeRecord } from '../record.js';
import { ensureTauDirectory } from '../tauDirectory.js';
import type { WakeMessage } from '../wake/wake.js';
import { inboxMessageType, readInboxReceipt } from './inbox.js';
import type { InboxEnvelope, InboxReceipt, ReceiptEntryFact } from './inbox.js';
import { createReceiptStore } from './receipts.js';
import { createReceiver } from './receive.js';
import type { InboxScanContext } from './receive.js';

const terminal = 't7';
const sessionId = 'session-1';
const messageId = '22222222-2222-4222-8222-222222222222';
const answerText = '{"assignmentId":"a","questionId":"q","answerPath":"/answers/q.json"}';

const labelArguments = (fake: HcFake): string[][] =>
  fake.calls
    .filter((call) => call.commandArguments[0] === 'label')
    .map((call) => call.commandArguments);

const queueAnswer = async (): Promise<HcFake> => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = join(directory, `${messageId}.json`);
  const fake = createHcFake();

  const envelope: InboxEnvelope = {
    version: 2,
    messageId,
    targetTerminal: terminal,
    targetSessionId: sessionId,
    family: 'answer',
    text: answerText,
  };

  await writeRecord(path, envelope);

  fake.reply(
    'get',
    JSON.stringify({
      address: terminal,
      state: 'live',
      labels: { 'tau.inbox': `${sessionId}:9999999999999`, [`tau.inbox.${messageId}`]: path },
    }),
  );

  fake.reply('label', JSON.stringify({ address: terminal, state: 'live', labels: {} }));

  return fake;
};

const startReceiver = (fake: HcFake, messages: WakeMessage[]) =>
  createReceiver({
    hc: { exec: fake.exec, connect: fake.connect, cwd: '/repository' },
    terminal,
    sessionId,
    gate: { whenReady: () => Promise.resolve(), isReady: () => true },
    wake: (_context, message) => {
      messages.push(message);
    },
    notify: () => undefined,
    receipts: createReceiptStore(sessionId),
    fence: {
      observe: () => undefined,
      isCurrent: () => true,
      confirmOwnership: () => Promise.resolve(true),
    },
  });

const contextOf = (entries: ReceiptEntryFact[]): InboxScanContext =>
  ({
    sessionManager: { getEntries: () => entries },
    ui: { notify: () => undefined },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as InboxScanContext;

it('delivers an answer envelope once and restores its receipt after a reload', async () => {
  const fake = await queueAnswer();
  const messages: WakeMessage[] = [];
  const entries: ReceiptEntryFact[] = [];

  await startReceiver(fake, messages).scan(contextOf(entries));

  const receipt: InboxReceipt = { version: 2, messageId, sessionId, family: 'answer' };

  const entry: ReceiptEntryFact = {
    type: 'custom_message',
    customType: messages[0]?.customType,
    details: messages[0]?.details,
  };

  expect(messages).toHaveLength(1);
  expect(messages[0]?.content).toBe(answerText);
  expect(messages[0]?.customType).toBe(inboxMessageType);
  expect(messages[0]?.details).toEqual(receipt);
  expect(readInboxReceipt(entry)).toEqual(receipt);

  entries.push(entry);

  await startReceiver(fake, messages).scan(contextOf(entries));

  expect(messages).toHaveLength(1);

  expect(labelArguments(fake)).toEqual([
    ['label', '--json', '--', terminal, `tau.inbox.${messageId}=`],
  ]);
});
