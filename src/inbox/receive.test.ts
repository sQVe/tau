import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { createReceiptStore, createReceiver } from './inbox.js';
import type { MessageReply, MessageRequest } from './protocol.js';
import type { ReceiverOptions } from './receive.js';

let root = '';

beforeEach(() => {
  root = mkdtempSync('/tmp/tau-receive-');
  chmodSync(root, 0o700);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const recordOf = (sessionId: string, messageId: string) =>
  join(root, 'records', sessionId, `${messageId}.json`);

const queued = (sessionId: string, messageId: string) => ({
  protocol: 'rpc1',
  kind: 'queued',
  messageId,
  terminal: 't7',
  sessionId,
});

const directReceiver = (sessionId: string, accepts: ReceiverOptions['accepts'], holds = 0) => {
  const woken: unknown[] = [];
  let heldWakes = holds;

  const receiver = createReceiver({
    directory: join(root, 'records', sessionId),
    terminal: 't7',
    sessionId,
    accepts,
    receipts: createReceiptStore(sessionId),
    entries: () => [],
    wake: (message) => {
      if (heldWakes > 0) {
        heldWakes -= 1;

        return false;
      }

      woken.push(message);

      return true;
    },
    notify: () => undefined,
  });

  return { receiver, woken };
};

const messageRequest = (sessionId: string, messageId: string): MessageRequest => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId,
  targetTerminal: 't7',
  targetSessionId: sessionId,
  family: 'handover',
  payload: { text: 'handover text' },
});

it('refuses a message its family check rejects and saves nothing', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();

  const { receiver } = directReceiver(sessionId, {
    handover: () => Promise.resolve('The question is closed.'),
  });

  await expect(receiver.accept(messageRequest(sessionId, messageId))).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'The question is closed.',
    messageId,
  });

  expect(existsSync(join(root, 'records', sessionId))).toBe(false);
});

it('refuses a family name that only the object prototype defines and saves nothing', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const { receiver, woken } = directReceiver(sessionId, {});

  const request: MessageRequest = Object.assign(messageRequest(sessionId, messageId), {
    family: 'toString',
  });

  await expect(receiver.accept(request)).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'This session does not accept toString messages.',
    messageId,
  });

  expect(existsSync(join(root, 'records', sessionId))).toBe(false);
  expect(woken).toEqual([]);
});

it('refuses to save an answer-request message and saves nothing', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();

  const { receiver, woken } = directReceiver(sessionId, {
    'answer-request': (_request, save) => save(),
  });

  const request: MessageRequest = {
    ...messageRequest(sessionId, messageId),
    family: 'answer-request',
    payload: {
      assignmentId: randomUUID(),
      questionId: randomUUID(),
      answer: 'Use option A.',
    },
  };

  await expect(receiver.accept(request)).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'This session does not save answer-request messages.',
    messageId,
  });

  expect(existsSync(join(root, 'records', sessionId))).toBe(false);
  expect(woken).toEqual([]);
});

it('accepts a handover while an answer-request check is still waiting', async () => {
  const sessionId = randomUUID();
  const requestMessageId = randomUUID();
  const handoverId = randomUUID();
  const pending = Promise.withResolvers<MessageReply>();

  const { receiver } = directReceiver(sessionId, {
    'answer-request': () => pending.promise,
    handover: (_request, save) => save(),
  });

  const answerRequest: MessageRequest = {
    ...messageRequest(sessionId, requestMessageId),
    family: 'answer-request',
    payload: {
      assignmentId: randomUUID(),
      questionId: randomUUID(),
      answer: 'Use option A.',
    },
  };

  const waiting = receiver.accept(answerRequest);

  await expect(receiver.accept(messageRequest(sessionId, handoverId))).resolves.toEqual(
    queued(sessionId, handoverId),
  );

  pending.resolve({
    protocol: 'rpc1',
    kind: 'queued',
    messageId: requestMessageId,
    terminal: 't7',
    sessionId,
  });

  await expect(waiting).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'queued',
    messageId: requestMessageId,
    terminal: 't7',
    sessionId,
  });
});

it('saves an accepted architect-ask as a handover with its text', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();

  const { receiver, woken } = directReceiver(sessionId, {
    'architect-ask': (_request, save) => save(),
  });

  const request: MessageRequest = {
    ...messageRequest(sessionId, messageId),
    family: 'architect-ask',
    payload: { text: 'Ask text', lockToken: 'lock-1' },
  };

  await expect(receiver.accept(request)).resolves.toEqual(queued(sessionId, messageId));
  await receiver.deliver(new AbortController().signal);

  expect(JSON.parse(readFileSync(recordOf(sessionId, messageId), 'utf8'))).toEqual({
    version: 1,
    messageId,
    family: 'handover',
    payload: { text: 'Ask text' },
  });

  expect(woken).toMatchObject([{ content: 'Ask text', details: { family: 'handover' } }]);
});

it('saves an architect-ask retry of a saved message once', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();

  const { receiver } = directReceiver(sessionId, {
    'architect-ask': (_request, save) => save(),
  });

  const request: MessageRequest = {
    ...messageRequest(sessionId, messageId),
    family: 'architect-ask',
    payload: { text: 'Ask text', lockToken: 'lock-1' },
  };

  await receiver.accept(request);

  await expect(receiver.accept(request)).resolves.toEqual(queued(sessionId, messageId));
});

it('saves an accepted answer and wakes with its answer text', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const { receiver, woken } = directReceiver(sessionId, { answer: (_request, save) => save() });

  const questionId = randomUUID();

  const request: MessageRequest = {
    ...messageRequest(sessionId, messageId),
    family: 'answer',
    payload: {
      assignmentId: randomUUID(),
      questionId,
      parentSession: 'parent',
      answer: 'Use option A.',
    },
  };

  await expect(receiver.accept(request)).resolves.toEqual(queued(sessionId, messageId));
  await receiver.deliver(new AbortController().signal);

  expect(woken).toEqual([
    {
      customType: 'tau-inbox-message',
      content: 'Use option A.',
      display: true,
      details: { version: 2, messageId, sessionId, family: 'answer', questionId },
    },
  ]);
});

it('queues the first of two overlapping saves of one message ID and refuses the other', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const { receiver } = directReceiver(sessionId, { handover: (_request, save) => save() });
  const first = messageRequest(sessionId, messageId);
  const second: MessageRequest = { ...first, family: 'handover', payload: { text: 'other text' } };

  const replies = await Promise.all([receiver.accept(first), receiver.accept(second)]);

  expect(replies).toEqual([
    queued(sessionId, messageId),
    {
      protocol: 'rpc1',
      kind: 'refused',
      reason: `Message ${messageId} is already saved with different content.`,
      messageId,
    },
  ]);

  expect(JSON.parse(readFileSync(recordOf(sessionId, messageId), 'utf8'))).toMatchObject({
    payload: { text: 'handover text' },
  });
});

it('delivers a held message in a later drain', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();

  const { receiver, woken } = directReceiver(
    sessionId,
    { handover: (_request, save) => save() },
    1,
  );

  await receiver.accept(messageRequest(sessionId, messageId));
  await receiver.deliver(new AbortController().signal);

  expect(woken).toEqual([]);

  await receiver.deliver(new AbortController().signal);

  expect(woken).toHaveLength(1);
});
