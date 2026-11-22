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
import { setAcceptCheck } from '../../inbox/inbox.js';
import { createInboxExtension } from './inbox.js';

interface HcState {
  labels: Map<string, string>;
  failLabel: boolean;
  malformedLabelReply?: boolean;
  failGet?: boolean;
  failGetAfterLabel?: boolean;
  foregroundPid?: number | null;
  afterRead?: (() => Promise<void>) | undefined;
  onLabel?: (() => Promise<void> | void) | undefined;
  labelWrites: string[];
}

interface HarnessOptions {
  state?: HcState;
  socketDirectory?: string;
  processGroup?: number;
}

const raceWaitMilliseconds = 200;
const foregroundProcessGroup = 100;

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

  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const hcState = (overrides: Partial<HcState> = {}): HcState => ({
  labels: new Map(),
  failLabel: false,
  foregroundPid: foregroundProcessGroup,
  labelWrites: [],
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
    state.labelWrites.push(assignments.join(' '));

    if (state.failLabel) {
      return failedResult('label refused');
    }

    const onLabel = state.onLabel;

    state.onLabel = undefined;
    await onLabel?.();

    for (const assignment of assignments) {
      const [key = '', value = ''] = assignment.split('=');

      if (value === '') {
        state.labels.delete(key);
      } else {
        state.labels.set(key, value);
      }
    }

    if (state.malformedLabelReply === true) {
      return succeededResult('{');
    }

    return succeededResult(terminal());
  };
};

const socketOf = (sessionId: string): string => join(root, 'sockets', `${sessionId}.sock`);

const contextFor = (
  sessionId: string,
  notify: (message: string, level?: string) => void,
): ExtensionContext =>
  ({
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    ui: {
      notify: (message: string, level?: string) => {
        notify(message, level);
      },
    },
    isIdle: () => true,
    signal: undefined,
  }) as unknown as ExtensionContext;

const startHarness = (options: HarnessOptions = {}) => {
  const state = options.state ?? hcState();
  const socketDirectory = options.socketDirectory ?? join(root, 'sockets');
  const fake = fakeExtensionApi();
  const notices: string[] = [];
  const levels: (string | undefined)[] = [];
  const firstNotice = Promise.withResolvers<undefined>();

  const notify = (message: string, level?: string): void => {
    notices.push(message);
    levels.push(level);
    firstNotice.resolve(undefined);
  };

  createInboxExtension({
    hc: { exec: hcExec(state), connect: () => Promise.reject(new Error('no connect')), cwd: root },
    socketDirectory: () => socketDirectory,
    inboxDirectory: () => join(root, 'records'),
    processGroup: () => Promise.resolve(options.processGroup ?? foregroundProcessGroup),
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

  const waitForInbox = async (sessionId: string): Promise<void> => {
    await vi.waitFor(
      () => {
        expect(state.labels.get('tau.inbox')).toBe(`rpc1:${socketOf(sessionId)}`);
      },
      { timeout: 5_000 },
    );
  };

  const startAndAdvertise = async (sessionId: string) => {
    const context = await start(sessionId);

    await waitForInbox(sessionId);

    return context;
  };

  const shutdown = (sessionId: string) =>
    emit('session_shutdown', { reason: 'quit' }, contextFor(sessionId, notify));

  const discover = (sessionId: string) =>
    emit('resources_discover', { type: 'resources_discover' }, contextFor(sessionId, notify));

  return {
    state,
    notices,
    levels,
    firstNotice: firstNotice.promise,
    sendMessage: fake.sendMessage,
    start,
    startAndAdvertise,
    waitForInbox,
    shutdown,
    discover,
  };
};

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

  await harness.startAndAdvertise(sessionId);
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

it('advertises its inbox when the terminal reports its foreground only after startup', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const state = hcState({ foregroundPid: null });
  const harness = startHarness({ state, processGroup: foregroundProcessGroup });
  const sessionId = randomUUID();

  state.afterRead = () => {
    state.foregroundPid = foregroundProcessGroup;

    return Promise.resolve();
  };

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await vi.waitFor(() => {
    expect(state.labels.get('tau.inbox')).toBe(`rpc1:${socketOf(sessionId)}`);
  });

  await expect(exchange(socketOf(sessionId), handoverTo(sessionId))).resolves.toMatchObject({
    kind: 'queued',
    sessionId,
  });
});

it('closes the earlier listener when a second session start arrives without shutdown', async () => {
  const harness = startHarness();
  const first = randomUUID();
  const second = randomUUID();

  await harness.startAndAdvertise(first);
  await harness.startAndAdvertise(second);
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

  await harness.startAndAdvertise(sessionId);
  await harness.startAndAdvertise(sessionId);
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
  await harness.firstNotice;

  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([expect.stringContaining('Tau inbox could not start:')]);
});

it('removes the label it applied when the label reply is malformed', async () => {
  const harness = startHarness({ state: hcState({ malformedLabelReply: true }) });

  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));
  await harness.firstNotice;

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
  await harness.firstNotice;

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

  await harness.startAndAdvertise(sessionId);
  await harness.shutdown(sessionId);

  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(Object.fromEntries(harness.state.labels)).toEqual({});
});

it('leaves a label that names another socket at shutdown', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();

  await harness.startAndAdvertise(sessionId);
  harness.state.labels.set('tau.inbox', 'rpc1:/tmp/tau-1000/other.sock');
  await harness.shutdown(sessionId);

  expect(existsSync(socketOf(sessionId))).toBe(false);

  expect(Object.fromEntries(harness.state.labels)).toEqual({
    'tau.inbox': 'rpc1:/tmp/tau-1000/other.sock',
  });
});

it('refuses an answer request when a non-worker session has no answer-request check', async () => {
  const harness = startHarness();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  await harness.startAndAdvertise(sessionId);
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

    await harness.startAndAdvertise(sessionId);
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

    await harness.startAndAdvertise(sessionId);
    cleanups.push(() => harness.shutdown(sessionId));

    await expect(
      exchange(socketOf(sessionId), architectAskTo(sessionId, messageId)),
    ).resolves.toEqual({ protocol: 'rpc1', kind: 'refused', reason: 'Not this lock.', messageId });
  },
);

it('refuses an architect-ask without a registered check and saves nothing', async () => {
  forgetAcceptCheck('architect-ask');

  const harness = startHarness();
  const sessionId = randomUUID();
  const messageId = randomUUID();

  await harness.startAndAdvertise(sessionId);
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

  await harness.startAndAdvertise(sessionId);
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

  await harness.startAndAdvertise(sessionId);
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

  await harness.startAndAdvertise(sessionId);
  await exchange(socketOf(sessionId), handoverTo(sessionId));
  await harness.shutdown(sessionId);
  await settle();

  expect(harness.sendMessage).not.toHaveBeenCalled();

  await harness.startAndAdvertise(sessionId);
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

  await harness.startAndAdvertise(sessionId);
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

  await harness.startAndAdvertise(sessionId);
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

  await harness.startAndAdvertise(sessionId);
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
  await harness.firstNotice;

  expect(existsSync(join(socketDirectory, `${sessionId}.sock`))).toBe(false);

  expect(harness.notices).toEqual([
    `Tau inbox could not start: Inbox directory ${socketDirectory} has mode 755; it must be 700.`,
  ]);
});

it('leaves a replacement listener and its label when a replaced lifecycle shuts down', async () => {
  const state = hcState();
  const replaced = startHarness({ state });
  const replacement = startHarness({ state });
  const first = randomUUID();
  const second = randomUUID();

  await replaced.startAndAdvertise(first);
  await replacement.startAndAdvertise(second);
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

  await replaced.startAndAdvertise(sessionId);
  await replacement.startAndAdvertise(sessionId);
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

  await harness.startAndAdvertise(sessionId);
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

  await earlier.startAndAdvertise(first);

  state.afterRead = () => {
    readStarted.resolve(undefined);

    return releaseRead.promise;
  };

  const shutdown = earlier.shutdown(first);

  await readStarted.promise;

  const starting = replacement.startAndAdvertise(second);

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

it("keeps the foreground session's label when a second Pi on its terminal starts and exits", async () => {
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

  await parent.startAndAdvertise(parentSession);
  const parentLabelWrites = state.labelWrites.length;

  cleanups.push(() => parent.shutdown(parentSession));
  await child.start(childSession);
  await settle();
  await expectParentInbox();
  await child.shutdown(childSession);
  await expectParentInbox();

  expect(existsSync(socketOf(childSession))).toBe(false);
  expect(state.labelWrites).toHaveLength(parentLabelWrites);
  expect(child.notices).toEqual([]);
});

it('starts no inbox when the session ends while the terminal is read', async () => {
  const state = hcState();
  const harness = startHarness({ state });
  const sessionId = randomUUID();
  const ended = Promise.withResolvers<undefined>();
  const labelReached = Promise.withResolvers<undefined>();
  const releaseLabel = Promise.withResolvers<undefined>();

  state.onLabel = () => {
    labelReached.resolve(undefined);

    return releaseLabel.promise;
  };

  state.afterRead = () => {
    const end = async (): Promise<void> => {
      try {
        await harness.shutdown(sessionId);
      } finally {
        ended.resolve(undefined);
      }
    };

    end().catch(() => undefined);

    return Promise.resolve();
  };

  await harness.start(sessionId);

  const outcome = await Promise.race([
    ended.promise.then(() => 'ended'),
    labelReached.promise.then(() => 'label'),
  ]);

  releaseLabel.resolve(undefined);
  await ended.promise;

  expect(outcome).toBe('ended');
  expect(state.labelWrites).toEqual([]);
  expect(Object.fromEntries(state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([]);
});

it('stays silent when the terminal read rejects after the session ends', async () => {
  const state = hcState();
  const harness = startHarness({ state });
  const sessionId = randomUUID();
  const ended = Promise.withResolvers<undefined>();

  state.afterRead = () => {
    const end = async (): Promise<void> => {
      try {
        await harness.shutdown(sessionId);
      } finally {
        ended.resolve(undefined);
      }
    };

    end().catch(() => undefined);

    return Promise.reject(new Error('read failed after the session ended'));
  };

  await harness.start(sessionId);
  await ended.promise;

  expect(state.labelWrites).toEqual([]);
  expect(Object.fromEntries(state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([]);
});

it('warns and starts no inbox when the terminal reports no foreground for 10 seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const harness = startHarness({ state: hcState({ foregroundPid: null }) });
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));

  await vi.advanceTimersByTimeAsync(9_999);

  expect(harness.notices).toEqual([]);
  expect(harness.levels).toEqual([]);

  await vi.advanceTimersByTimeAsync(1);

  expect(Object.fromEntries(harness.state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toHaveLength(1);
  expect(harness.levels).toEqual(['warning']);
});

it('starts no inbox and shows no notice when the session ends during the wait', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });

  const harness = startHarness({ state: hcState({ foregroundPid: null }) });
  const sessionId = randomUUID();

  await harness.start(sessionId);
  await harness.shutdown(sessionId);
  await vi.advanceTimersByTimeAsync(10_000);

  expect(harness.state.labelWrites).toEqual([]);
  expect(Object.fromEntries(harness.state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([]);
});

it('leaves one listener and label when a second session start arrives while the first advertises', async () => {
  const state = hcState();
  const harness = startHarness({ state });
  const first = randomUUID();
  const second = randomUUID();
  const labelReached = Promise.withResolvers<undefined>();
  const releaseLabel = Promise.withResolvers<undefined>();

  state.onLabel = () => {
    labelReached.resolve(undefined);

    return releaseLabel.promise;
  };

  await harness.start(first);
  await labelReached.promise;

  const starting = harness.start(second);

  releaseLabel.resolve(undefined);
  await starting;
  await harness.waitForInbox(second);
  cleanups.push(() => harness.shutdown(second));

  expect(existsSync(socketOf(first))).toBe(false);

  await expect(exchange(socketOf(second), handoverTo(second))).resolves.toMatchObject({
    sessionId: second,
  });

  expect(Object.fromEntries(state.labels)).toEqual({ 'tau.inbox': `rpc1:${socketOf(second)}` });
});

it('reports that the inbox could not start when the terminal read fails', async () => {
  const harness = startHarness({ state: hcState({ failGet: true }) });
  const sessionId = randomUUID();

  await harness.start(sessionId);
  cleanups.push(() => harness.shutdown(sessionId));
  await harness.firstNotice;

  expect(Object.fromEntries(harness.state.labels)).toEqual({});
  expect(existsSync(socketOf(sessionId))).toBe(false);
  expect(harness.notices).toEqual([expect.stringContaining('Tau inbox could not start:')]);
});
