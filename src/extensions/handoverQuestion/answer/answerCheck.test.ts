import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../../tests/gitRepository.js';
import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import type { AcceptCheck } from '../../../inbox/inbox.js';
import { createReceiver } from '../../../inbox/inbox.js';
import type { MessageReply, MessageRequest } from '../../../inbox/protocol.js';
import { createReceiptStore } from '../../../inbox/receipts.js';
import {
  questionRecordDirectory,
  readQuestionRecord,
  writeQuestionRecord,
} from '../question/questionRecord.js';
import { handoverAnswerCheck } from './answerCheck.js';
import { answeredRecord, openRecord } from './fixtures/answerRecord.js';

type Save = Parameters<AcceptCheck>[1];

const questionId = '11111111-1111-4111-8111-111111111111';
const askerSession = '22222222-2222-4222-8222-222222222222';
const senderSession = '33333333-3333-4333-8333-333333333333';
const otherId = '44444444-4444-4444-8444-444444444444';
const answer = 'Use option A.';

const answerRequest = (messageId = questionId): MessageRequest => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId,
  targetTerminal: 'worker-1',
  targetSessionId: askerSession,
  family: 'handover-answer',
  payload: { questionId, senderSession, answer },
});

const queuedReply: MessageReply = {
  protocol: 'rpc1',
  kind: 'queued',
  messageId: questionId,
  terminal: 'worker-1',
  sessionId: askerSession,
};

const refusedReply: MessageReply = {
  protocol: 'rpc1',
  kind: 'refused',
  reason: 'The inbox is full.',
  messageId: questionId,
};

const startReceiver = (root: string) => {
  const woken: { arrival: string; content: string }[] = [];
  const directory = join(root, 'records', askerSession);

  const receiver = createReceiver({
    directory,
    terminal: 'worker-1',
    sessionId: askerSession,
    accepts: { 'handover-answer': handoverAnswerCheck(() => root) },
    receipts: createReceiptStore(askerSession),
    entries: () => [],
    wake: (message, arrival) => {
      woken.push({ arrival, content: message.content });

      return true;
    },
    notify: () => undefined,
  });

  return { receiver, woken, directory };
};

it('marks the record answered and starts the turn with the answer text', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeQuestionRecord(root, openRecord(senderSession));
  const { receiver, woken } = startReceiver(root);

  const reply = await receiver.accept(answerRequest());

  expect(reply).toEqual(queuedReply);

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: answeredRecord(senderSession, answer),
  });

  await receiver.deliver(new AbortController().signal);

  expect(woken).toEqual([
    { arrival: 'arrived', content: `Handover answer to question ${questionId}:\n\n${answer}` },
  ]);
});

const recordBytes = async (root: string): Promise<string | undefined> => {
  try {
    return await readFile(join(questionRecordDirectory(root), `${questionId}.json`), 'utf8');
  } catch {
    return undefined;
  }
};

it('refuses a message ID other than the question ID and saves nothing', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeQuestionRecord(root, openRecord(senderSession));
  const { receiver, woken, directory } = startReceiver(root);
  const before = await recordBytes(root);

  const reply = await receiver.accept(answerRequest(otherId));

  expect(reply).toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'A handover answer must use its question ID as its message ID.',
    messageId: otherId,
  });

  expect(existsSync(directory)).toBe(false);
  expect(await recordBytes(root)).toEqual(before);
  expect(woken).toEqual([]);
});

it('queues a repeat of the saved answer without a second turn', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeQuestionRecord(root, openRecord(senderSession));
  const { receiver, woken } = startReceiver(root);

  const first = await receiver.accept(answerRequest());
  const second = await receiver.accept(answerRequest());

  expect(first).toMatchObject({ kind: 'queued' });
  expect(second).toMatchObject({ kind: 'queued' });

  await receiver.deliver(new AbortController().signal);

  expect(woken).toHaveLength(1);

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: answeredRecord(senderSession, answer),
  });
});

it('refuses another family with the family in the reason', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const save = vi.fn<Save>();

  const request: MessageRequest = {
    protocol: 'rpc1',
    kind: 'message',
    messageId: questionId,
    targetTerminal: 'worker-1',
    targetSessionId: askerSession,
    family: 'handover',
    payload: { text: 'Hello.' },
  };

  const reply = await handoverAnswerCheck(() => root)(request, save);

  expect(reply).toBe('This check accepts handover answers, not handover messages.');
  expect(save).not.toHaveBeenCalled();
});

it('refuses when the session cwd is outside a Git checkout and saves nothing', async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-no-checkout-');
  const save = vi.fn<Save>();

  const reply = await handoverAnswerCheck(() => directory)(answerRequest(), save);

  expect(reply).toBe(
    `The handover_answer tool needs a Git checkout, and ${directory} is not in one.`,
  );

  expect(save).not.toHaveBeenCalled();
  expect(existsSync(join(directory, '.tau'))).toBe(false);
});

it('writes the answered record before the save runs', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeQuestionRecord(root, openRecord(senderSession));

  const states: string[] = [];

  const save = vi.fn<Save>().mockImplementation(async () => {
    const read = await readQuestionRecord(root, questionId);
    const state = read.kind === 'record' ? read.record.state : read.kind;

    states.push(state);

    return queuedReply;
  });

  const reply = await handoverAnswerCheck(() => root)(answerRequest(), save);

  expect(reply).toEqual(queuedReply);
  expect(states).toEqual(['answered']);

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: answeredRecord(senderSession, answer),
  });
});

it('restores the open record when the save is refused', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeQuestionRecord(root, openRecord(senderSession));

  const states: string[] = [];

  const save = vi.fn<Save>().mockImplementation(async () => {
    const read = await readQuestionRecord(root, questionId);
    const state = read.kind === 'record' ? read.record.state : read.kind;

    states.push(state);

    return refusedReply;
  });

  const reply = await handoverAnswerCheck(() => root)(answerRequest(), save);

  expect(reply).toEqual(refusedReply);
  expect(states).toEqual(['answered']);

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: openRecord(senderSession),
  });
});

it('restores the open record when the save throws', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeQuestionRecord(root, openRecord(senderSession));

  const save = vi.fn<Save>().mockRejectedValue(new Error('The inbox is full.'));

  const check = handoverAnswerCheck(() => root)(answerRequest(), save);

  await expect(check).rejects.toThrow('The inbox is full.');

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: openRecord(senderSession),
  });
});
