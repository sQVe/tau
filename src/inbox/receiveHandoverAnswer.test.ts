import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { createReceiptStore, createReceiver } from './inbox.js';
import type { MessageRequest } from './protocol.js';
import { inboxMessageType } from './receiptDecision.js';
import type { ReceiptEntryFact } from './receiptDecision.js';

const handoverAnswer = (
  sessionId: string,
  messageId: string,
  questionId: string,
): MessageRequest => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId,
  targetTerminal: 't7',
  targetSessionId: sessionId,
  family: 'handover-answer',
  payload: { questionId, senderSession: 'lead-session', answer: 'Use option A.' },
});

const queued = (sessionId: string, messageId: string) => ({
  protocol: 'rpc1',
  kind: 'queued',
  messageId,
  terminal: 't7',
  sessionId,
});

const recordOf = (directory: string, sessionId: string, messageId: string): string =>
  join(directory, 'records', sessionId, `${messageId}.json`);

const shownText = (questionId: string): string =>
  `Handover answer to question ${questionId}:\n\nUse option A.`;

const receiptEntry = (
  sessionId: string,
  messageId: string,
  questionId: string,
): ReceiptEntryFact => ({
  type: 'custom_message',
  customType: inboxMessageType,
  content: shownText(questionId),
  details: { version: 4, messageId, sessionId, family: 'handover-answer', questionId },
});

const startReceiver = (
  directory: string,
  sessionId: string,
  entries: () => readonly ReceiptEntryFact[],
) => {
  const woken: unknown[] = [];

  const receiver = createReceiver({
    directory: join(directory, 'records', sessionId),
    terminal: 't7',
    sessionId,
    accepts: { 'handover-answer': (_request, save) => save() },
    receipts: createReceiptStore(sessionId),
    entries,
    wake: (message) => {
      woken.push(message);

      return true;
    },
    notify: () => undefined,
  });

  return { receiver, woken };
};

it('saves a handover-answer and wakes once with its fixed text', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-receive-handover-answer-');
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const questionId = randomUUID();
  const { receiver, woken } = startReceiver(directory, sessionId, () => []);

  await expect(receiver.accept(handoverAnswer(sessionId, messageId, questionId))).resolves.toEqual(
    queued(sessionId, messageId),
  );

  await receiver.deliver(new AbortController().signal);

  expect(JSON.parse(readFileSync(recordOf(directory, sessionId, messageId), 'utf8'))).toEqual({
    version: 4,
    messageId,
    family: 'handover-answer',
    payload: { questionId, senderSession: 'lead-session', answer: 'Use option A.' },
  });

  expect(woken).toEqual([
    {
      customType: 'tau-inbox-message',
      content: shownText(questionId),
      display: true,
      details: { version: 4, messageId, sessionId, family: 'handover-answer', questionId },
    },
  ]);
});

it('queues a handover-answer retry before the drain without reaching the receipt match', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-receive-handover-answer-');
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const questionId = randomUUID();
  const { receiver, woken } = startReceiver(directory, sessionId, () => []);
  const request = handoverAnswer(sessionId, messageId, questionId);

  await receiver.accept(request);
  await receiver.deliver(new AbortController().signal);

  await expect(receiver.accept(request)).resolves.toEqual(queued(sessionId, messageId));

  expect(existsSync(recordOf(directory, sessionId, messageId))).toBe(true);
  expect(woken).toHaveLength(1);
});

it('queues a handover-answer retry after its receipt is saved without a second wake', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-receive-handover-answer-');
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const questionId = randomUUID();
  const entries: ReceiptEntryFact[] = [];
  const { receiver, woken } = startReceiver(directory, sessionId, () => entries);
  const request = handoverAnswer(sessionId, messageId, questionId);

  await receiver.accept(request);
  await receiver.deliver(new AbortController().signal);

  entries.push(receiptEntry(sessionId, messageId, questionId));

  await receiver.deliver(new AbortController().signal);

  expect(existsSync(recordOf(directory, sessionId, messageId))).toBe(false);

  await expect(receiver.accept(request)).resolves.toEqual(queued(sessionId, messageId));

  expect(existsSync(recordOf(directory, sessionId, messageId))).toBe(false);

  await receiver.deliver(new AbortController().signal);

  expect(woken).toHaveLength(1);
});
