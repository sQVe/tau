import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Exec } from '../src/command.js';
import { createInboxExtension } from '../src/extensions/inbox/inbox.js';
import { succeededResult } from './execFake.js';
import { fakeExtensionApi } from './extensionApi.js';

interface Entry {
  type: string;
  customType?: string;
  content?: unknown;
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

const startReceiver = async (sessionId: string, mode = 'tui') => {
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
  const piState = { idle: true, signal: undefined as AbortSignal | undefined };

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
    mode,
    isIdle: () => piState.idle,
    get signal() {
      return piState.signal;
    },
  } as unknown as ExtensionContext;

  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    for (const handler of fake.handlers.get(name) ?? []) {
      await handler({ type: name, ...event } as never, context);
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
        content: message.content,
        details: message.details,
      });
    }
  };

  const shown = (count: number) => () => sendMessage.mock.calls.length >= count;

  return { sendMessage, entries, notices, piState, emit, saveReceipts, shown };
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

it('receives a handover in a session with a custom Pi session ID', async () => {
  const sessionId = 'job-1';
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  await receiver.emit('resources_discover');

  await expect(exchange(socketOf(sessionId), handover(sessionId, messageId))).resolves.toEqual(
    queued(sessionId, messageId),
  );

  await until(receiver.shown(1));

  expect(receiver.notices).toEqual([]);

  expect(receiver.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    content: 'handover text',
    details: { messageId, sessionId },
  });
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

it('refuses a retry of a receipted message with different text and shows nothing new', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  receiver.saveReceipts();
  await receiver.emit('agent_end');
  await until(deleted(sessionId, messageId));

  await expect(
    exchange(socketOf(sessionId), handover(sessionId, messageId, 'other text')),
  ).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: `Message ${messageId} is already saved with different content.`,
    messageId,
  });

  await receiver.emit('agent_end');

  expect(existsSync(recordOf(sessionId, messageId))).toBe(false);
  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
});

// Every Pi TUI abort, Escape included, clears Pi's queue first. Pi returns only queued user text to
// the editor, so an inbox message goes nowhere.
const pressEscape = async (receiver: Awaited<ReturnType<typeof startReceiver>>) => {
  await receiver.emit('agent_end');
  await receiver.emit('agent_settled', { aborted: true });
};

const optionsOfShown = (receiver: Awaited<ReturnType<typeof startReceiver>>) =>
  receiver.sendMessage.mock.calls.map(([, options]) => options);

it('shows a message again once, without a turn, after Escape dropped it from the Pi queue', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  await pressEscape(receiver);
  await until(receiver.shown(2));

  receiver.saveReceipts();
  await receiver.emit('agent_settled', { aborted: false });
  await until(deleted(sessionId, messageId));

  expect(optionsOfShown(receiver)).toEqual([{ triggerTurn: true }, { triggerTurn: false }]);

  expect(receiver.sendMessage.mock.calls.map(([message]) => message.details)).toEqual([
    { version: 2, messageId, sessionId, family: 'handover' },
    { version: 2, messageId, sessionId, family: 'handover' },
  ]);
});

it('does not show a message again after an aborted settle outside the terminal UI', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId, 'rpc');

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  await pressEscape(receiver);
  await flush();

  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
  expect(existsSync(recordOf(sessionId, messageId))).toBe(true);
});

it('shows a message again once after a retry backoff, a dequeue, and a cancel', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);
  const run = new AbortController();

  await receiver.emit('resources_discover');
  receiver.piState.idle = false;
  receiver.piState.signal = run.signal;
  await receiver.emit('agent_start');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));

  // The agent loop ends into a retry backoff. The user dequeues and then cancels the retry. Pi
  // settles without an abort and with an empty queue, and no turn ends in between.
  receiver.piState.signal = undefined;
  await receiver.emit('agent_end');
  receiver.piState.idle = true;
  await receiver.emit('agent_settled', { aborted: false });
  await until(receiver.shown(2));
  receiver.saveReceipts();
  await receiver.emit('agent_settled', { aborted: false });
  await until(deleted(sessionId, messageId));

  expect(optionsOfShown(receiver)).toEqual([
    { deliverAs: 'steer', triggerTurn: true },
    { triggerTurn: false },
  ]);
});

// Pi's TUI clears its queue and aborts the run in one step. A message that arrives after that and
// before the settle must not be steered, or Pi keeps it while Tau shows it again.
it.each([
  ['while the run aborts', 'aborted'],
  ['after the aborted agent loop ended', 'none'],
] as const)('shows a message that arrives %s once, after the settle', async (_when, signal) => {
  const sessionId = randomUUID();
  const droppedId = randomUUID();
  const lateId = randomUUID();
  const receiver = await startReceiver(sessionId);
  const run = new AbortController();

  await receiver.emit('resources_discover');
  receiver.piState.idle = false;
  receiver.piState.signal = run.signal;
  await receiver.emit('agent_start');
  await exchange(socketOf(sessionId), handover(sessionId, droppedId));
  await until(receiver.shown(1));

  run.abort();

  if (signal === 'none') {
    receiver.piState.signal = undefined;
    await receiver.emit('agent_end');
  }

  await exchange(socketOf(sessionId), handover(sessionId, lateId, 'late text'));
  await flush();

  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);

  receiver.piState.signal = undefined;
  receiver.piState.idle = true;
  await receiver.emit('agent_settled', { aborted: true });
  await until(receiver.shown(3));
  await flush();

  const shownMessages = receiver.sendMessage.mock.calls.map(([message, options]) => ({
    content: message.content,
    options,
  }));

  expect(
    shownMessages.toSorted((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    ),
  ).toEqual([
    { content: 'handover text', options: { deliverAs: 'steer', triggerTurn: true } },
    { content: 'handover text', options: { triggerTurn: false } },
    { content: 'late text', options: { triggerTurn: true } },
  ]);
});

it('never shows a message again that Pi held and then delivered', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId, 'rpc');

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  await pressEscape(receiver);
  receiver.saveReceipts();
  await receiver.emit('agent_settled', { aborted: false });
  await until(deleted(sessionId, messageId));
  await receiver.emit('agent_settled', { aborted: true });
  await flush();

  expect(receiver.sendMessage).toHaveBeenCalledTimes(1);
});

it('does not show a receipted message again after an abort', async () => {
  const sessionId = randomUUID();
  const messageId = randomUUID();
  const receiver = await startReceiver(sessionId);

  await receiver.emit('resources_discover');
  await exchange(socketOf(sessionId), handover(sessionId, messageId));
  await until(receiver.shown(1));
  receiver.saveReceipts();
  await pressEscape(receiver);
  await until(deleted(sessionId, messageId));

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
