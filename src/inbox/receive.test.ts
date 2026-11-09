import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { createReceiptStore, createReceiver } from './inbox.js';
import type { MessageRequest } from './protocol.js';
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
