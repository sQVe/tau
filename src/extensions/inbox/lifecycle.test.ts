import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { failedResult, succeededResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import type { Exec } from '../../command.js';
import { createInboxExtension } from './inbox.js';

interface HcState {
  labels: Map<string, string>;
  failLabel: boolean;
  // Runs after `hc get` read the labels and before it returns them.
  afterRead?: (() => Promise<void>) | undefined;
}

interface HarnessOptions {
  state?: HcState;
  socketDirectory?: string;
}

const raceWaitMilliseconds = 200;

let root = '';
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  root = mkdtempSync('/tmp/tau-lifecycle-');
  chmodSync(root, 0o700);
  vi.stubEnv('HC_TERMINAL_ID', 't7');
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }

  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// Answers `hc get` and `hc label` for terminal t7 from one label map.
const hcExec = (state: HcState): Exec => {
  const terminal = () =>
    JSON.stringify({ address: 't7', state: 'live', labels: Object.fromEntries(state.labels) });

  return async (_command, commandArguments) => {
    const subcommand = commandArguments[0];
    const assignments = commandArguments.slice(4);

    if (subcommand === 'get') {
      const snapshot = terminal();
      const { afterRead } = state;

      state.afterRead = undefined;
      await afterRead?.();

      return succeededResult(snapshot);
    }

    if (state.failLabel) {
      return failedResult('label refused');
    }

    for (const assignment of assignments) {
      const [key = '', value = ''] = assignment.split('=');

      if (value === '') {
        state.labels.delete(key);
      } else {
        state.labels.set(key, value);
      }
    }

    return succeededResult(terminal());
  };
};

const contextFor = (sessionId: string, notify: (message: string) => void): ExtensionContext =>
  ({
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: {
      notify: (message: string) => {
        notify(message);
      },
    },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as ExtensionContext;

const startHarness = (options: HarnessOptions = {}) => {
  const state: HcState = options.state ?? { labels: new Map(), failLabel: false };
  const socketDirectory = options.socketDirectory ?? join(root, 'sockets');
  const fake = fakeExtensionApi();
  const notices: string[] = [];
  const firstNotice = Promise.withResolvers<undefined>();

  const notify = (message: string): void => {
    notices.push(message);
    firstNotice.resolve(undefined);
  };

  createInboxExtension({
    hc: { exec: hcExec(state), connect: () => Promise.reject(new Error('no connect')), cwd: root },
    socketDirectory: () => socketDirectory,
    inboxDirectory: () => join(root, 'records'),
  })(fake.pi);

  const emit = async (name: string, event: unknown, context: ExtensionContext) => {
    for (const handler of fake.handlers.get(name) ?? []) {
      await handler(event as never, context);
    }
  };

  const start = async (sessionId: string) => {
    const context = contextFor(sessionId, notify);

    await emit('session_start', { reason: 'startup' }, context);

    return context;
  };

  const shutdown = (sessionId: string) =>
    emit('session_shutdown', { reason: 'quit' }, contextFor(sessionId, notify));

  const discover = (sessionId: string) =>
    emit('resources_discover', { type: 'resources_discover' }, contextFor(sessionId, notify));

  return {
    state,
    notices,
    firstNotice: firstNotice.promise,
    sendMessage: fake.sendMessage,
    start,
    shutdown,
    discover,
  };
};

const socketOf = (sessionId: string): string => join(root, 'sockets', `${sessionId}.sock`);

// Sends a string as raw bytes and any other value as one JSON frame.
const exchange = (path: string, request: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const frame = typeof request === 'string' ? request : `${JSON.stringify(request)}\n`;
    const socket = createConnection(path);
    let reply = '';

    socket.setEncoding('utf8');

    socket.once('connect', () => {
      socket.end(frame);
    });

    socket.on('data', (chunk: string) => {
      reply += chunk;
    });

    socket.once('close', () => {
      try {
        resolve(JSON.parse(reply));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.once('error', reject);
  });

const handoverTo = (sessionId: string, messageId = randomUUID()) => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId,
  targetTerminal: 't7',
  targetSessionId: sessionId,
  family: 'handover',
  payload: { text: 'handover text' },
});

const answerTo = (sessionId: string, messageId = randomUUID()) => ({
  ...handoverTo(sessionId, messageId),
  family: 'answer',
  payload: {
    assignmentId: randomUUID(),
    questionId: randomUUID(),
    parentSession: 'parent',
    answer: 'Use option A.',
  },
});

const settle = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 20);
  });

it('queues a message and advertises its socket after session start', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await expect(exchange(socketOf(sessionId), handoverTo(sessionId, messageId))).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'queued',
    messageId,
    terminal: 't7',
    sessionId,
  });

  expect(Object.fromEntries(harness.state.labels)).toEqual({
    'tau.inbox': `rpc1:${socketOf(sessionId)}`,
  });
});

it('closes the earlier listener when a second session start arrives without shutdown', async () => {
  const harness = startHarness();
  const first = randomUUID();
  const second = randomUUID();

  await harness.start(first);
  await harness.start(second);
  cleanups.push(() => harness.shutdown(second));

  expect(existsSync(socketOf(first))).toBe(false);

  await expect(exchange(socketOf(second), handoverTo(second))).resolves.toMatchObject({
    sessionId: second,
  });

  expect(Object.fromEntries(harness.state.labels)).toEqual({
    'tau.inbox': `rpc1:${socketOf(second)}`,
  });
});

it('keeps one answering listener when the same session starts twice', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.start(sessionId);
  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await expect(exchange(socketOf(sessionId), handoverTo(sessionId))).resolves.toMatchObject({
    sessionId,
  });
});

it('closes the unadvertised socket and reports when the label cannot be set', async () => {
  const harness = startHarness({ state: { labels: new Map(), failLabel: true } });
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([expect.stringContaining('Tau inbox could not start:')]);
});

it('starts no listener without a terminal address', async () => {
  vi.stubEnv('HC_TERMINAL_ID', '');

  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(Object.fromEntries(harness.state.labels)).toEqual({});
});

it('removes its socket and label at shutdown', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.start(sessionId);
  await harness.shutdown(sessionId);

  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(Object.fromEntries(harness.state.labels)).toEqual({});
});

it('leaves a label that names another socket at shutdown', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.start(sessionId);
  harness.state.labels.set('tau.inbox', 'rpc1:/tmp/tau-1000/other.sock');
  await harness.shutdown(sessionId);

  expect(existsSync(socketOf(sessionId))).toBe(false);

  expect(Object.fromEntries(harness.state.labels)).toEqual({
    'tau.inbox': 'rpc1:/tmp/tau-1000/other.sock',
  });
});

it('refuses a family the session does not accept', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await expect(exchange(socketOf(sessionId), answerTo(sessionId, messageId))).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'This session does not accept answer messages.',
    messageId,
  });
});

it('refuses a message addressed to another session', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();
  const otherSession = randomUUID();
  const messageId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await expect(exchange(socketOf(sessionId), handoverTo(otherSession, messageId))).resolves.toEqual(
    {
      protocol: 'rpc1',
      kind: 'refused',
      reason: `This inbox is terminal t7, session ${sessionId}.`,
      messageId,
    },
  );
});

it('delivers queued messages only after the startup gate opens', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));
  await exchange(socketOf(sessionId), handoverTo(sessionId));
  await settle();

  expect(harness.sendMessage).not.toHaveBeenCalled();

  await harness.discover(sessionId);

  await vi.waitFor(() => {
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });

  expect(harness.notices).toEqual([]);
});

it('cancels delivery of an ended generation and delivers only in the next one', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.start(sessionId);
  await exchange(socketOf(sessionId), handoverTo(sessionId));
  await harness.shutdown(sessionId);
  await settle();

  expect(harness.sendMessage).not.toHaveBeenCalled();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));
  await harness.discover(sessionId);

  await vi.waitFor(() => {
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });

  await settle();

  expect(harness.sendMessage).toHaveBeenCalledTimes(1);
});

it('drains again when a message is queued after startup', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));
  await harness.discover(sessionId);
  await settle();
  await exchange(socketOf(sessionId), handoverTo(sessionId));

  await vi.waitFor(() => {
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });
});

it('refuses a frame that is not valid JSON', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await expect(exchange(socketOf(sessionId), '{"protocol":\n')).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'The frame is not valid JSON.',
  });
});

it('refuses a message addressed to another terminal', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  const request = { ...handoverTo(sessionId, messageId), targetTerminal: 't9' };

  await expect(exchange(socketOf(sessionId), request)).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: `This inbox is terminal t7, session ${sessionId}.`,
    messageId,
  });
});

it('refuses to start in a socket directory other users can read', async () => {
  const socketDirectory = join(root, 'shared');

  mkdirSync(socketDirectory, { mode: 0o755 });
  chmodSync(socketDirectory, 0o755);

  const harness = startHarness({ socketDirectory });
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(existsSync(join(socketDirectory, `${sessionId}.sock`))).toBe(false);

  expect(harness.notices).toEqual([
    `Tau inbox could not start: Inbox directory ${socketDirectory} has mode 755; it must be 700.`,
  ]);
});

it('leaves a replacement listener and its label when a replaced lifecycle shuts down', async () => {
  const state: HcState = { labels: new Map(), failLabel: false };
  const replaced = startHarness({ state });
  const replacement = startHarness({ state });
  const first = randomUUID();
  const second = randomUUID();

  await replaced.start(first);
  await replacement.start(second);
  cleanups.push(() => replacement.shutdown(second));
  await replaced.shutdown(first);

  await expect(exchange(socketOf(second), handoverTo(second))).resolves.toMatchObject({
    sessionId: second,
  });

  expect(Object.fromEntries(state.labels)).toEqual({ 'tau.inbox': `rpc1:${socketOf(second)}` });
});

it('leaves the label of a replacement with the same session when a replaced lifecycle shuts down', async () => {
  const state: HcState = { labels: new Map(), failLabel: false };
  const replaced = startHarness({ state });
  const replacement = startHarness({ state });
  const sessionId = randomUUID();

  await replaced.start(sessionId);
  await replacement.start(sessionId);
  cleanups.push(() => replacement.shutdown(sessionId));
  await replaced.shutdown(sessionId);

  await expect(exchange(socketOf(sessionId), handoverTo(sessionId))).resolves.toMatchObject({
    sessionId,
  });

  expect(Object.fromEntries(state.labels)).toEqual({ 'tau.inbox': `rpc1:${socketOf(sessionId)}` });
});

it('reports a delivery that fails in the current generation', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  harness.sendMessage.mockImplementation(() => {
    throw new Error('display failed');
  });

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));
  await harness.discover(sessionId);
  await settle();
  await exchange(socketOf(sessionId), handoverTo(sessionId));
  await harness.firstNotice;

  expect(harness.notices).toEqual(['Tau inbox delivery failed: display failed']);
});

it('keeps the label a replacement wrote while an earlier shutdown was reading it', async () => {
  const state: HcState = { labels: new Map(), failLabel: false };
  const earlier = startHarness({ state });
  const replacement = startHarness({ state });
  const first = randomUUID();
  const second = randomUUID();
  const readStarted = Promise.withResolvers<undefined>();
  const releaseRead = Promise.withResolvers<undefined>();

  await earlier.start(first);

  state.afterRead = () => {
    readStarted.resolve(undefined);

    return releaseRead.promise;
  };

  const shutdown = earlier.shutdown(first);

  await readStarted.promise;

  const starting = replacement.start(second);

  // Without ordering, the replacement advertises while the read is held. With ordering it waits
  // for the shutdown, so the read is released after a bounded real wait instead.
  await Promise.race([
    starting,
    new Promise((resolve) => {
      setTimeout(resolve, raceWaitMilliseconds);
    }),
  ]);

  releaseRead.resolve(undefined);
  await Promise.all([shutdown, starting]);
  cleanups.push(() => replacement.shutdown(second));

  await expect(exchange(socketOf(second), handoverTo(second))).resolves.toMatchObject({
    sessionId: second,
  });

  expect(Object.fromEntries(state.labels)).toEqual({ 'tau.inbox': `rpc1:${socketOf(second)}` });
});
