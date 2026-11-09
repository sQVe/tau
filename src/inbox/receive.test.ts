import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { succeededResult } from '../../tests/execFake.js';
import { fakeExtensionApi } from '../../tests/extensionApi.js';
import type { Exec } from '../command.js';
import { createInboxExtension } from '../extensions/inbox/inbox.js';
import { createReceiptStore, createReceiver } from './inbox.js';
import type { MessageRequest } from './protocol.js';
import type { ReceiverOptions } from './receive.js';

interface Entry {
  type: string;
  customType?: string;
  details?: unknown;
}

const readHold = vi.hoisted(() => ({
  held: undefined as Promise<void> | undefined,
  reads: 0,
  reached: Promise.withResolvers<undefined>(),
}));

// Delivery runs after the handler that starts it returns, so tests wait for the outcome it reports.
const outcomeWaiters = vi.hoisted(() => new Set<() => void>());

const reportOutcome = vi.hoisted(() => () => {
  for (const check of outcomeWaiters) {
    check();
  }
});

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    readFile: (async (...parameters: Parameters<typeof actual.readFile>) => {
      const { held } = readHold;
      const [path] = parameters;

      const recordRead =
        held !== undefined && typeof path === 'string' && path.includes('/records/');

      if (recordRead && readHold.reads++ > 0) {
        readHold.reached.resolve(undefined);
        await held;
      }

      return actual.readFile(...parameters);
    }) as typeof actual.readFile,
    unlink: async (...parameters: Parameters<typeof actual.unlink>) => {
      try {
        await actual.unlink(...parameters);
      } finally {
        reportOutcome();
      }
    },
  };
});

let root = '';
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  root = mkdtempSync('/tmp/tau-receive-');
  chmodSync(root, 0o700);
  vi.stubEnv('HC_TERMINAL_ID', 't7');
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }

  readHold.held = undefined;
  readHold.reads = 0;
  readHold.reached = Promise.withResolvers<undefined>();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const hcExec: Exec = (_command, commandArguments) => {
  const labels = commandArguments[0] === 'get' ? {} : undefined;

  return Promise.resolve(succeededResult(JSON.stringify({ address: 't7', state: 'live', labels })));
};

const until = (condition: () => boolean) =>
  new Promise<void>((resolve) => {
    const check = () => {
      if (condition()) {
        outcomeWaiters.delete(check);
        resolve();
      }
    };

    outcomeWaiters.add(check);
    check();
  });

const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 20);
  });

const startReceiver = async (sessionId: string) => {
  const sendMessage = vi.fn<ExtensionAPI['sendMessage']>();

  const fake = fakeExtensionApi({
    sendMessage: (...parameters) => {
      try {
        sendMessage(...parameters);
      } finally {
        reportOutcome();
      }
    },
  });

  const entries: Entry[] = [];
  const notices: string[] = [];

  createInboxExtension({
    hc: { exec: hcExec, connect: () => Promise.reject(new Error('no connect')), cwd: root },
    socketDirectory: () => join(root, 'sockets'),
    inboxDirectory: () => join(root, 'records'),
  })(fake.pi);

  const context = {
    sessionManager: { getSessionId: () => sessionId, getEntries: () => entries },
    ui: {
      notify: (message: string) => {
        notices.push(message);
        reportOutcome();
      },
    },
    isIdle: () => true,
    signal: undefined,
  } as unknown as ExtensionContext;

  const emit = async (name: string) => {
    for (const handler of fake.handlers.get(name) ?? []) {
      await handler({ type: name } as never, context);
    }

    await flush();
  };

  await emit('session_start');
  cleanups.push(() => emit('session_shutdown'));

  const saveReceipts = () => {
    for (const [message] of sendMessage.mock.calls) {
      entries.push({
        type: 'custom_message',
        customType: message.customType,
        details: message.details,
      });
    }
  };

  const shown = (count: number) => () => sendMessage.mock.calls.length >= count;

  return { sendMessage, entries, notices, emit, saveReceipts, shown };
};

const exchange = (path: string, request: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let reply = '';

    socket.setEncoding('utf8');

    socket.once('connect', () => {
      socket.end(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk: string) => {
      reply += chunk;
    });

    socket.once('close', () => {
      resolve(JSON.parse(reply));
    });

    socket.once('error', reject);
  });

const handover = (sessionId: string, messageId: string, text = 'handover text') => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId,
  targetTerminal: 't7',
  targetSessionId: sessionId,
  family: 'handover',
  payload: { text },
});

const socketOf = (sessionId: string) => join(root, 'sockets', `${sessionId}.sock`);

const recordOf = (sessionId: string, messageId: string) =>
  join(root, 'records', sessionId, `${messageId}.json`);

const deleted = (sessionId: string, messageId: string) => () =>
  !existsSync(recordOf(sessionId, messageId));

const queued = (sessionId: string, messageId: string) => ({
  protocol: 'rpc1',
  kind: 'queued',
  messageId,
  terminal: 't7',
  sessionId,
});

it('replies queued after saving the record and shows nothing until the startup gate opens', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  await expect(exchange(socketOf(sessionId), handover(sessionId, messageId))).resolves.toEqual(
    queued(sessionId, messageId),
  );

  expect(existsSync(recordOf(sessionId, messageId))).toBe(true);

  await flush();

  expect(receiver.sendMessage).not.toHaveBeenCalled();

  await receiver.emit('resources_discover');
  await until(receiver.shown(1));

  expect(receiver.sendMessage.mock.calls).toEqual([
    [
      {
        customType: 'tau-inbox-message',
        content: 'handover text',
        display: true,
        details: { version: 2, messageId, sessionId, family: 'handover' },
      },
      { triggerTurn: true },
    ],
  ]);
});

it('wakes once per message across repeated drains and deletes the record only after its receipt', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  await receiver.emit('agent_end');

  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
  expect(existsSync(recordOf(sessionId, messageId))).toBe(true);

  receiver.saveReceipts();
  await receiver.emit('agent_end');
  await until(deleted(sessionId, messageId));

  expect(existsSync(recordOf(sessionId, messageId))).toBe(false);
  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
});

it('restores receipts after a reload and deletes a delivered record without another message', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  receiver.saveReceipts();
  await receiver.emit('session_start');
  await receiver.emit('resources_discover');
  await until(deleted(sessionId, messageId));

  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
  expect(existsSync(recordOf(sessionId, messageId))).toBe(false);
});

it('answers a retry of a receipted message as queued without saving or showing it again', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  receiver.saveReceipts();
  await receiver.emit('agent_end');
  await until(deleted(sessionId, messageId));

  await expect(exchange(socketOf(sessionId), handover(sessionId, messageId))).resolves.toEqual(
    queued(sessionId, messageId),
  );

  await receiver.emit('agent_end');

  expect(existsSync(recordOf(sessionId, messageId))).toBe(false);
  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
});

it('answers a pending retry with the same text as queued and refuses different text', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  await startReceiver(sessionId);

  await exchange(socketOf(sessionId), handover(sessionId, messageId));

  await expect(exchange(socketOf(sessionId), handover(sessionId, messageId))).resolves.toEqual(
    queued(sessionId, messageId),
  );

  await expect(
    exchange(socketOf(sessionId), handover(sessionId, messageId, 'other text')),
  ).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: `Message ${messageId} is already saved with different content.`,
    messageId,
  });
});

it('wakes again in a later drain when showing a message failed', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  receiver.sendMessage.mockImplementationOnce(() => {
    throw new Error('display failed');
  });

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  await receiver.emit('agent_end');
  await until(receiver.shown(2));

  expect(receiver.notices).toEqual(['Tau inbox delivery failed: display failed']);
  expect(receiver.sendMessage).toHaveBeenCalledTimes(2);
});

it('reports a malformed record once and still delivers a valid one', async () => {
  const sessionId = randomUUID();
  const malformedId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  mkdirSync(join(root, 'records', sessionId), { recursive: true });
  writeFileSync(recordOf(sessionId, malformedId), '{');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await receiver.emit('resources_discover');
  await until(() => receiver.shown(1)() && receiver.notices.length > 0);
  await receiver.emit('agent_end');

  expect(receiver.notices).toEqual([
    `Tau inbox skipped message ${malformedId}: Malformed inbox record ${recordOf(sessionId, malformedId)}: not JSON.`,
  ]);

  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
});

it('wakes a message once when a same-session replacement starts during a record read', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);
  const release = Promise.withResolvers<undefined>();

  await receiver.emit('resources_discover');
  readHold.held = release.promise.then(() => undefined);
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await readHold.reached.promise;
  await receiver.emit('session_start');
  await receiver.emit('resources_discover');
  release.resolve(undefined);
  await until(receiver.shown(1));
  await flush();

  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
});

it('wakes nothing when the session shuts down during a record read', async () => {
  const sessionId = randomUUID();
  const receiver = await startReceiver(sessionId);
  const release = Promise.withResolvers<undefined>();

  await receiver.emit('resources_discover');
  readHold.held = release.promise.then(() => undefined);
  await exchange(socketOf(sessionId), handover(sessionId, randomUUID()));
  await readHold.reached.promise;
  await receiver.emit('session_shutdown');
  release.resolve(undefined);
  await flush();

  expect(receiver.sendMessage).not.toHaveBeenCalled();
});

const directReceiver = (sessionId: string, accepts: ReceiverOptions['accepts']) => {
  const woken: unknown[] = [];

  const receiver = createReceiver({
    directory: join(root, 'records', sessionId),
    terminal: 't7',
    sessionId,
    accepts,
    receipts: createReceiptStore(sessionId),
    entries: () => [],
    wake: (message) => woken.push(message),
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
