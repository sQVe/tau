import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { failedResult, succeededResult } from '../../../tests/execFake.js';
import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { forgetAcceptCheck } from '../../../tests/inboxReceiverHarness.js';
import type { Exec } from '../../command.js';
import { currentTerminalAddress } from '../../hc/hc.js';
import { releaseInbox, setAcceptCheck, advertiseLabel } from '../../inbox/inbox.js';
import { inboxRecordVersion, saveMessage } from '../../inbox/store.js';
import { createWake } from '../../wake/wake.js';
import { registerInboxLifecycle } from './lifecycle.js';
import { ownerWaitDelay } from './ownerDecision.js';
import { createStartupGate } from './startup.js';

interface HcState {
  labels: Map<string, string>;
  failLabel: boolean;
  malformedLabelReply?: boolean;
  failGet?: boolean;
  failGetAfterLabel?: boolean;
  foregroundPid?: number | null;
  afterRead?: (() => Promise<void>) | undefined;
  afterLabel?: (() => Promise<void>) | undefined;
}

interface HarnessOptions {
  state?: HcState;
  socketDirectory?: string;
  processGroup?: number;
}

const raceWaitMilliseconds = 200;
const foregroundProcessGroup = 100;

const ownerWaitMilliseconds = (() => {
  let total = 0;
  let attempt = 0;
  let delay = ownerWaitDelay(attempt);

  while (delay !== undefined) {
    total += delay;
    attempt += 1;
    delay = ownerWaitDelay(attempt);
  }

  return total;
})();

const useFakeTimers = (): void => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
};

let root = '';
const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  root = mkdtempSync('/tmp/tau-lifecycle-');
  chmodSync(root, 0o700);
  vi.stubEnv('HC_TERMINAL_ID', 't7');
});

afterEach(async () => {
  vi.useRealTimers();

  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }

  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const hcState = (overrides: Partial<HcState> = {}): HcState => ({
  labels: new Map(),
  failLabel: false,
  foregroundPid: foregroundProcessGroup,
  ...overrides,
});

const foregroundOf = (pid: number | null | undefined) =>
  typeof pid === 'number' ? { pid, name: 'pi', argv: ['pi'], cwd: root } : pid;

const hcExec = (state: HcState): Exec => {
  const terminal = () =>
    JSON.stringify({
      address: 't7',
      state: 'live',
      foreground: foregroundOf(state.foregroundPid),
      labels: Object.fromEntries(state.labels),
    });

  let labelCalls = 0;

  return async (_command, commandArguments) => {
    const subcommand = commandArguments[0];
    const assignments = commandArguments.slice(4);
    const failsAfterLabel = state.failGetAfterLabel === true && labelCalls > 0;
    const failsGet = state.failGet === true || failsAfterLabel;

    if (subcommand === 'get' && failsGet) {
      return failedResult('get refused');
    }

    if (subcommand === 'get') {
      const snapshot = terminal();
      const { afterRead } = state;

      state.afterRead = undefined;
      await afterRead?.();

      return succeededResult(snapshot);
    }

    labelCalls += 1;

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

    const { afterLabel } = state;

    state.afterLabel = undefined;
    await afterLabel?.();

    if (state.malformedLabelReply === true) {
      return succeededResult('{');
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
  const state = options.state ?? hcState();
  const socketDirectory = options.socketDirectory ?? join(root, 'sockets');
  // The cases below call `releaseInbox` so a replacement attachment can claim the slot again.
  const owner = Symbol('tau inbox');
  const fake = fakeExtensionApi();
  const notices: string[] = [];
  const firstNotice = Promise.withResolvers<undefined>();

  const notify = (message: string): void => {
    notices.push(message);
    firstNotice.resolve(undefined);
  };

  registerInboxLifecycle(fake.pi, {
    owner,
    hc: { exec: hcExec(state), connect: () => Promise.reject(new Error('no connect')), cwd: root },
    terminal: currentTerminalAddress,
    socketDirectory: () => socketDirectory,
    inboxDirectory: () => join(root, 'records'),
    processGroup: () => Promise.resolve(options.processGroup ?? foregroundProcessGroup),
    gate: createStartupGate(fake.pi),
    wake: createWake(fake.pi),
  });

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
    owner,
    notices,
    firstNotice: firstNotice.promise,
    sendMessage: fake.sendMessage,
    start,
    shutdown,
    discover,
  };
};

const socketOf = (sessionId: string): string => join(root, 'sockets', `${sessionId}.sock`);

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
        const socketError = error instanceof Error ? error : new Error(String(error));
        reject(socketError);
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

const answerRequestTo = (sessionId: string, messageId = randomUUID()) => ({
  ...handoverTo(sessionId, messageId),
  family: 'answer-request',
  payload: {
    assignmentId: randomUUID(),
    questionId: randomUUID(),
    answer: 'Use option A.',
  },
});

const architectAskTo = (sessionId: string, messageId = randomUUID()) => ({
  ...handoverTo(sessionId, messageId),
  family: 'architect-ask',
  payload: { text: 'Ask text', lockToken: 'lock-1' },
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
  const harness = startHarness({ state: hcState({ failLabel: true }) });
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([expect.stringContaining('Tau inbox could not start:')]);
});

it('removes the label it applied when the label reply is malformed', async () => {
  const harness = startHarness({ state: hcState({ malformedLabelReply: true }) });

  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(Object.fromEntries(harness.state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([expect.stringContaining('Tau inbox could not start:')]);
});

it('reports the label error when removing the applied label also fails', async () => {
  const harness = startHarness({
    state: hcState({ malformedLabelReply: true, failGetAfterLabel: true }),
  });

  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([expect.stringContaining('hc label t7')]);
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

it('releases the inbox claim when withdrawal fails at shutdown', async () => {
  const state = hcState();
  const first = startHarness({ state });
  const firstSession = randomUUID();
  const replacement = startHarness({ state });
  const replacementSession = randomUUID();

  await first.start(firstSession);
  state.failLabel = true;

  await expect(first.shutdown(firstSession)).rejects.toThrow('hc label t7 failed: label refused');

  state.failLabel = false;
  await replacement.start(replacementSession);
  cleanups.push(() => replacement.shutdown(replacementSession));

  expect(Object.fromEntries(state.labels)).toEqual({
    'tau.inbox': `rpc1:${socketOf(replacementSession)}`,
  });

  await expect(
    exchange(socketOf(replacementSession), handoverTo(replacementSession)),
  ).resolves.toMatchObject({ sessionId: replacementSession });
});

it('refuses an answer request when a non-worker session has no answer-request check', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await expect(
    exchange(socketOf(sessionId), answerRequestTo(sessionId, messageId)),
  ).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'This session does not accept answer-request messages.',
    messageId,
  });
});

it.each([
  { role: '', family: 'answer', kind: 'refused' },
  { role: 'worker', family: 'answer', kind: 'queued' },
  { role: '', family: 'answer-request', kind: 'queued' },
])(
  'answers a worker answer check as $kind in a session with role "$role"',
  async ({ role, family, kind }) => {
    vi.stubEnv('TAU_ROLE', role);

    const harness = startHarness();
    const sessionId = randomUUID();
    const messageId = randomUUID();

    setAcceptCheck('answer', (_request, save) => save());

    setAcceptCheck('answer-request', async () => ({
      protocol: 'rpc1',
      kind: 'queued',
      messageId,
      terminal: 't7',
      sessionId,
    }));

    await harness.start(sessionId);
    cleanups.push(() => harness.shutdown(sessionId));

    const request =
      family === 'answer' ? answerTo(sessionId, messageId) : answerRequestTo(sessionId, messageId);

    await expect(exchange(socketOf(sessionId), request)).resolves.toMatchObject({
      kind,
      messageId,
    });
  },
);

it.each(['', 'architect', 'worker'])(
  'passes a registered architect-ask check in a session with role "%s"',
  async (role) => {
    vi.stubEnv('TAU_ROLE', role);

    const harness = startHarness();
    const sessionId = randomUUID();
    const messageId = randomUUID();

    setAcceptCheck('architect-ask', async () => 'Not this lock.');

    cleanups.push(() => {
      forgetAcceptCheck('architect-ask');
    });

    await harness.start(sessionId);
    cleanups.push(() => harness.shutdown(sessionId));

    await expect(
      exchange(socketOf(sessionId), architectAskTo(sessionId, messageId)),
    ).resolves.toEqual({ protocol: 'rpc1', kind: 'refused', reason: 'Not this lock.', messageId });
  },
);

it('passes a registered handover-question check in a non-worker session', async () => {
  vi.stubEnv('TAU_ROLE', '');

  const harness = startHarness();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  setAcceptCheck('handover-question', async () => 'The question is closed.');

  cleanups.push(() => {
    forgetAcceptCheck('handover-question');
  });

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await expect(
    exchange(socketOf(sessionId), {
      ...handoverTo(sessionId, messageId),
      family: 'handover-question',
      payload: {
        questionId: randomUUID(),
        text: 'Which option should I use?',
        askerTerminal: 'worker',
        askerSession: randomUUID(),
      },
    }),
  ).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'The question is closed.',
    messageId,
  });

  expect(existsSync(join(root, 'records', sessionId))).toBe(false);
});

it('refuses an architect-ask without a registered check and saves nothing', async () => {
  forgetAcceptCheck('architect-ask');

  const harness = startHarness();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await expect(
    exchange(socketOf(sessionId), architectAskTo(sessionId, messageId)),
  ).resolves.toEqual({
    protocol: 'rpc1',
    kind: 'refused',
    reason: 'This session does not accept architect-ask messages.',
    messageId,
  });

  expect(existsSync(join(root, 'records', sessionId))).toBe(false);
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

it('serves one inbox when a process keeps two lifecycles', async () => {
  const state = hcState();
  const first = startHarness({ state });
  const second = startHarness({ state });
  const firstSession = randomUUID();
  const secondSession = randomUUID();

  await first.start(firstSession);
  await second.start(secondSession);
  cleanups.push(() => second.shutdown(secondSession));
  cleanups.push(() => first.shutdown(firstSession));

  expect(Object.fromEntries(state.labels)).toEqual({
    'tau.inbox': `rpc1:${socketOf(firstSession)}`,
  });

  expect(existsSync(socketOf(firstSession))).toBe(true);
  expect(existsSync(socketOf(secondSession))).toBe(false);

  await second.shutdown(secondSession);

  await expect(exchange(socketOf(firstSession), handoverTo(firstSession))).resolves.toMatchObject({
    sessionId: firstSession,
  });

  expect(Object.fromEntries(state.labels)).toEqual({
    'tau.inbox': `rpc1:${socketOf(firstSession)}`,
  });
});

it('leaves a replacement listener and its label when a replaced lifecycle shuts down', async () => {
  const state = hcState();
  const replaced = startHarness({ state });
  const replacement = startHarness({ state });
  const first = randomUUID();
  const second = randomUUID();

  await replaced.start(first);
  releaseInbox(replaced.owner);
  await replacement.start(second);
  cleanups.push(() => replacement.shutdown(second));
  await replaced.shutdown(first);

  await expect(exchange(socketOf(second), handoverTo(second))).resolves.toMatchObject({
    sessionId: second,
  });

  expect(Object.fromEntries(state.labels)).toEqual({ 'tau.inbox': `rpc1:${socketOf(second)}` });
});

it('leaves the label of a replacement with the same session when a replaced lifecycle shuts down', async () => {
  const state = hcState();
  const replaced = startHarness({ state });
  const replacement = startHarness({ state });
  const sessionId = randomUUID();

  await replaced.start(sessionId);
  releaseInbox(replaced.owner);
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
  const state = hcState();
  const earlier = startHarness({ state });
  const replacement = startHarness({ state });
  const first = randomUUID();
  const second = randomUUID();
  const readStarted = Promise.withResolvers<undefined>();
  const releaseRead = Promise.withResolvers<undefined>();

  await earlier.start(first);
  releaseInbox(earlier.owner);

  state.afterRead = () => {
    readStarted.resolve(undefined);

    return releaseRead.promise;
  };

  const shutdown = earlier.shutdown(first);

  await readStarted.promise;

  const starting = replacement.start(second);

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

it('keeps a replacement label that another process writes between the shutdown read and its clear', async () => {
  const state = hcState();
  const earlier = startHarness({ state });
  const first = randomUUID();
  const second = randomUUID();
  let replacementWrite: Promise<void> | undefined;

  await earlier.start(first);
  releaseInbox(earlier.owner);

  state.afterRead = () => {
    replacementWrite = advertiseLabel({
      hc: {
        exec: hcExec(state),
        connect: () => Promise.reject(new Error('no connect')),
        cwd: root,
      },
      terminal: 't7',
      directory: join(root, 'sockets'),
      path: socketOf(second),
    });

    const wait = new Promise<void>((resolve) => {
      setTimeout(resolve, raceWaitMilliseconds);
    });

    return Promise.race([replacementWrite, wait]);
  };

  await earlier.shutdown(first);
  await replacementWrite;

  expect(Object.fromEntries(state.labels)).toEqual({ 'tau.inbox': `rpc1:${socketOf(second)}` });
});

it("keeps the foreground session's label when a second Pi on its terminal starts and exits", async () => {
  useFakeTimers();

  const state = hcState({ foregroundPid: 100 });
  const parent = startHarness({ state, processGroup: 100 });
  const child = startHarness({ state, processGroup: 200 });
  const parentSession = randomUUID();
  const childSession = randomUUID();

  const expectParentInbox = async () => {
    expect(Object.fromEntries(state.labels)).toEqual({
      'tau.inbox': `rpc1:${socketOf(parentSession)}`,
    });

    await expect(
      exchange(socketOf(parentSession), handoverTo(parentSession)),
    ).resolves.toMatchObject({ kind: 'queued', sessionId: parentSession });
  };

  await parent.start(parentSession);
  cleanups.push(() => parent.shutdown(parentSession));
  releaseInbox(parent.owner);
  await child.start(childSession);
  await expectParentInbox();
  await child.shutdown(childSession);
  await expectParentInbox();

  expect(existsSync(socketOf(childSession))).toBe(false);
  expect(child.notices).toEqual([]);
});

it('starts no inbox when the session ends while the terminal is read', async () => {
  const state = hcState();
  const harness = startHarness({ state });
  const sessionId = randomUUID();

  state.afterRead = () => harness.shutdown(sessionId);

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(Object.fromEntries(state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([]);
});

it('starts no inbox when the session ends while the label is written', async () => {
  const state = hcState();
  const harness = startHarness({ state });
  const sessionId = randomUUID();
  const labelWritten = Promise.withResolvers<undefined>();
  const releaseLabel = Promise.withResolvers<undefined>();

  state.afterLabel = () => {
    labelWritten.resolve(undefined);

    return releaseLabel.promise;
  };

  const starting = harness.start(sessionId);

  cleanups.push(async () => {
    releaseLabel.resolve(undefined);
    await starting;
    await harness.shutdown(sessionId);
  });

  await labelWritten.promise;

  const shutdown = harness.shutdown(sessionId);

  releaseLabel.resolve(undefined);
  await shutdown;

  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(Object.fromEntries(state.labels)).toEqual({});

  await starting;

  expect(harness.notices).toEqual([]);
});

it('advertises its inbox once the terminal reports this process in the foreground', async () => {
  useFakeTimers();

  const harness = startHarness({ state: hcState({ foregroundPid: 400 }) });
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(Object.fromEntries(harness.state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);

  harness.state.foregroundPid = foregroundProcessGroup;
  await vi.advanceTimersByTimeAsync(ownerWaitMilliseconds);
  vi.useRealTimers();

  await vi.waitFor(() => {
    expect(Object.fromEntries(harness.state.labels)).toEqual({
      'tau.inbox': `rpc1:${socketOf(sessionId)}`,
    });
  });

  expect(harness.notices).toEqual([]);

  await expect(exchange(socketOf(sessionId), handoverTo(sessionId))).resolves.toMatchObject({
    kind: 'queued',
    sessionId,
  });
});

it.each([
  { name: 'another process', foregroundPid: 400, reports: 'terminal t7 reports pid 400' },
  { name: 'no process', foregroundPid: null, reports: 'hc reports no foreground process' },
])(
  'reports once that it has no inbox when the terminal reports $name in the foreground',
  async ({ foregroundPid, reports }) => {
    useFakeTimers();

    const harness = startHarness({ state: hcState({ foregroundPid }) });
    const sessionId = randomUUID();

    await harness.start(sessionId);
    cleanups.push(() => harness.shutdown(sessionId));

    expect(harness.notices).toEqual([]);

    await vi.advanceTimersByTimeAsync(ownerWaitMilliseconds);

    expect(harness.notices).toEqual([expect.stringContaining(reports)]);

    await vi.advanceTimersByTimeAsync(ownerWaitMilliseconds);

    expect(harness.notices).toHaveLength(1);
    expect(Object.fromEntries(harness.state.labels)).toEqual({});
    expect(existsSync(socketOf(sessionId))).toBe(false);
  },
);

it('drops the owner wait of a session start replaced before the terminal reports it', async () => {
  useFakeTimers();

  const harness = startHarness({ state: hcState({ foregroundPid: 400 }) });
  const first = randomUUID();
  const second = randomUUID();

  await harness.start(first);
  await harness.start(second);
  cleanups.push(() => harness.shutdown(second));

  expect(vi.getTimerCount()).toBe(1);

  harness.state.foregroundPid = foregroundProcessGroup;
  await vi.advanceTimersByTimeAsync(ownerWaitMilliseconds);
  vi.useRealTimers();

  await vi.waitFor(() => {
    expect(Object.fromEntries(harness.state.labels)).toEqual({
      'tau.inbox': `rpc1:${socketOf(second)}`,
    });
  });

  expect(existsSync(socketOf(first))).toBe(false);
});

it('delivers a message saved before the terminal reported this process in the foreground', async () => {
  useFakeTimers();

  const harness = startHarness({ state: hcState({ foregroundPid: 400 }) });
  const sessionId = randomUUID();
  const messageId = randomUUID();

  await saveMessage(join(root, 'records', sessionId), {
    version: inboxRecordVersion,
    messageId,
    family: 'handover',
    payload: { text: 'earlier text', sender: { terminal: 'lead', sessionId: randomUUID() } },
  });

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));
  await harness.discover(sessionId);

  expect(harness.sendMessage).not.toHaveBeenCalled();

  harness.state.foregroundPid = foregroundProcessGroup;
  await vi.advanceTimersByTimeAsync(ownerWaitMilliseconds);
  vi.useRealTimers();

  await vi.waitFor(() => {
    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
  });

  expect(harness.sendMessage.mock.calls[0]?.[0].details).toMatchObject({ messageId });
});

it('reports that the inbox could not start when the terminal read fails', async () => {
  const harness = startHarness({ state: hcState({ failGet: true }) });
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  expect(Object.fromEntries(harness.state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([expect.stringContaining('Tau inbox could not start:')]);
});
