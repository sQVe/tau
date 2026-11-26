import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { architectLockPath } from '../src/extensions/architect/lock.js';
import type { QuestionRecord } from '../src/extensions/handoverQuestion/question/questionRecord.js';
import {
  readQuestionRecord,
  writeQuestionRecord,
} from '../src/extensions/handoverQuestion/question/questionRecord.js';
import { readLiveLockHolder } from '../src/fileLock/fileLock.js';
import { socketDirectoryFor, socketPathFor } from '../src/inbox/endpoint.js';
import { acceptChecks } from '../src/inbox/inbox.js';
import type { MessageReply, MessageRequest } from '../src/inbox/protocol.js';
import { formatInboxLabel, inboxLabelKey } from '../src/inbox/protocol.js';
import tauRegistration from '../src/tau/tau.js';
import { createExecFake, succeededResult } from './execFake.js';
import { fakeExtensionApi } from './extensionApi.js';
import { openRecord, questionId } from './fixtures/answerRecord.js';
import { createTemporaryRepository } from './gitRepository.js';
import { forgetAcceptCheck } from './inboxReceiverHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';
import type { SuiteCleanup } from './temporaryDirectoryHarness.js';

type Handler = (event: never, context: ExtensionContext) => unknown;

interface Registration {
  index: number;
  name: string;
  handler: Handler;
  stack: string;
}

const requireRegistration = (
  registration: Registration | undefined,
  name: string,
): Registration => {
  if (registration === undefined) {
    throw new Error(`Tau did not register ${name}.`);
  }

  return registration;
};

const waitForMissing = async (path: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!existsSync(path)) {
      return;
    }

    await sleep(10);
  }
};

const recordRegistrations = (fake: ReturnType<typeof fakeExtensionApi>): Registration[] => {
  const registered: Registration[] = [];
  const on = fake.pi.on.bind(fake.pi) as (name: string, handler: Handler) => unknown;

  fake.pi.on = ((name: string, handler: Handler) => {
    registered.push({
      index: registered.length,
      name,
      handler,
      stack: new Error('handler registration').stack ?? '',
    });

    on(name, handler);
  }) as unknown as typeof fake.pi.on;

  return registered;
};

const registrationsFrom = (
  registered: Registration[],
  name: string,
  file: string,
): Registration[] =>
  registered.filter((entry) => entry.name === name && entry.stack.includes(file));

const answerSenderSession = '33333333-3333-4333-8333-333333333333';

const answerRecord = (sessionId: string): QuestionRecord => ({
  ...openRecord(answerSenderSession),
  askerTerminal: 't-worker',
  askerSession: sessionId,
});

const answerRequest = (sessionId: string): MessageRequest => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId: questionId,
  targetTerminal: 't-worker',
  targetSessionId: sessionId,
  family: 'handover-answer',
  payload: {
    questionId,
    senderSession: answerSenderSession,
    answer: 'Use option A.',
  },
});

const startAnswerFixture = async (onTestFinished: SuiteCleanup) => {
  const root = await createTemporaryRepository(onTestFinished);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-answer-order-');
  const outside = temporaryDirectory(onTestFinished, 'tau-outside-repository-');
  const sessionId = randomUUID();
  const processGroup = 100;
  const processCwd = vi.spyOn(process, 'cwd').mockReturnValue(outside);
  const uid = process.getuid?.();

  const socketPath =
    uid === undefined ? undefined : socketPathFor(socketDirectoryFor(uid), sessionId);

  const labels = socketPath === undefined ? {} : { [inboxLabelKey]: formatInboxLabel(socketPath) };
  const foreground = { pid: processGroup, name: 'pi', argv: ['pi'], cwd: root };
  const terminal = { address: 't-worker', state: 'live', foreground, labels };

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');
  vi.stubEnv('HC_TERMINAL_ID', 't-worker');

  onTestFinished(() => {
    processCwd.mockRestore();
    vi.unstubAllEnvs();
  });

  const execFake = createExecFake<'hc' | 'ps'>({
    keyOf: (command) => {
      if (command === 'hc') {
        return 'hc';
      }

      if (command === 'ps') {
        return 'ps';
      }

      return undefined;
    },
    handlerFor: (key) => {
      if (key === 'ps') {
        return () => succeededResult(`${String(processGroup)}\n`);
      }

      return () => succeededResult(JSON.stringify(terminal));
    },
  });

  const fake = fakeExtensionApi({ exec: execFake.exec });

  const registered = recordRegistrations(fake);

  await tauRegistration(fake.pi);

  const handoverStart = requireRegistration(
    registrationsFrom(registered, 'session_start', 'handoverQuestion/handoverQuestion.ts')[0],
    'the handover question session start',
  );

  const inboxStart = requireRegistration(
    registrationsFrom(registered, 'session_start', 'extensions/inbox/lifecycle.ts')[0],
    'the inbox session start',
  );

  const inboxShutdown = requireRegistration(
    registrationsFrom(registered, 'session_shutdown', 'extensions/inbox/lifecycle.ts')[0],
    'the inbox session shutdown',
  );

  const beforeInboxShutdown = registered.filter(
    (entry) => entry.name === 'session_shutdown' && entry.index < inboxShutdown.index,
  );

  return {
    root,
    sessionId,
    socketPath,
    calls: execFake.calls,
    handoverStart,
    inboxStart,
    inboxShutdown,
    beforeInboxShutdown,
  };
};

const setupAnswerScenario = async (onTestFinished: SuiteCleanup) => {
  const fixture = await startAnswerFixture(onTestFinished);

  await writeQuestionRecord(fixture.root, answerRecord(fixture.sessionId));

  const check = acceptChecks()['handover-answer'];

  if (check === undefined) {
    throw new Error('Tau registered no handover-answer check.');
  }

  const request = answerRequest(fixture.sessionId);

  const queued: MessageReply = {
    protocol: 'rpc1',
    kind: 'queued',
    messageId: questionId,
    terminal: 't-worker',
    sessionId: fixture.sessionId,
  };

  const save = () => Promise.resolve(queued);

  const context = {
    cwd: fixture.root,
    ui: { notify: () => undefined },
    shutdown: vi.fn<() => void>(),
    isProjectTrusted: (): boolean => true,
    sessionManager: {
      getSessionFile: () => join(fixture.root, 'answer-session.jsonl'),
      getSessionId: () => fixture.sessionId,
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;

  let inboxClosed = false;

  const closeInbox = async (): Promise<void> => {
    if (inboxClosed) {
      return;
    }

    await fixture.inboxShutdown.handler(
      { type: 'session_shutdown', reason: 'quit' } as never,
      context,
    );

    inboxClosed = true;
  };

  onTestFinished(closeInbox);

  return {
    ...fixture,
    closeInbox,
    context,
    check,
    request,
    queued,
    save,
  };
};

// Both tests register the process-wide handover checks, and setup can fail before a test can
// register its own cleanup.
afterEach(() => {
  forgetAcceptCheck('handover-answer');
  forgetAcceptCheck('handover-question');
});

it('inbox closes before the lock frees', async ({ onTestFinished }) => {
  const uid = process.getuid?.();

  if (uid === undefined) {
    throw new Error('The inbox shutdown test needs a POSIX user ID.');
  }

  const root = await createTemporaryRepository(onTestFinished);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-shutdown-');
  const sessionId = 'shutdown-test-session';
  const socketPath = socketPathFor(socketDirectoryFor(uid), sessionId);
  const lockPath = architectLockPath(root);
  const processGroup = 100;
  const withdrawalStarted = Promise.withResolvers<undefined>();
  const releaseWithdrawal = Promise.withResolvers<undefined>();
  let holdWithdrawal = false;

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('TAU_ROLE', 'architect');
  vi.stubEnv('TAU_ARCHITECT_ASK', '');
  vi.stubEnv('HC_TERMINAL_ID', 't-architect');

  const fake = fakeExtensionApi({
    exec: async (command, commandArguments) => {
      if (command === 'ps') {
        return succeededResult(`${String(processGroup)}\n`);
      }

      if (holdWithdrawal && commandArguments[0] === 'get') {
        holdWithdrawal = false;
        withdrawalStarted.resolve(undefined);
        await releaseWithdrawal.promise;
      }

      const labels = { 'tau.inbox': `rpc1:${socketPath}` };
      const foreground = { pid: processGroup, name: 'pi', argv: ['pi'], cwd: root };
      const terminal = { address: 't-architect', state: 'live', foreground, labels };

      return succeededResult(JSON.stringify(terminal));
    },
  });

  const registered = recordRegistrations(fake);

  await tauRegistration(fake.pi);

  const fromFile = (name: string, file: string): Registration[] =>
    registrationsFrom(registered, name, file);

  const inboxStart = requireRegistration(
    fromFile('session_start', 'extensions/inbox/lifecycle.ts')[0],
    'the inbox session start',
  );

  const architectStart = requireRegistration(
    fromFile('session_start', 'extensions/architect/architect.ts')[0],
    'the architect session start',
  );

  const inboxShutdown = requireRegistration(
    fromFile('session_shutdown', 'extensions/inbox/lifecycle.ts')[0],
    'the inbox session shutdown',
  );

  const architectShutdown = requireRegistration(
    fromFile('session_shutdown', 'extensions/architect/architect.ts')[0],
    'the architect session shutdown',
  );

  const context = {
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    shutdown: vi.fn<() => void>(),
    isProjectTrusted: (): boolean => true,
    sessionManager: {
      getSessionFile: () => join(root, 'architect-session.jsonl'),
      getSessionId: () => sessionId,
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;

  await inboxStart.handler({} as never, context);
  await architectStart.handler({} as never, context);

  expect(existsSync(socketPath)).toBe(true);
  expect(await readLiveLockHolder(lockPath)).toBeDefined();

  onTestFinished(async () => {
    releaseWithdrawal.resolve(undefined);
    await waitForMissing(socketPath);
    vi.unstubAllEnvs();
  });

  expect(inboxShutdown.index).toBeLessThan(architectShutdown.index);

  holdWithdrawal = true;

  const inboxDone = Promise.resolve(inboxShutdown.handler({ reason: 'quit' } as never, context));

  const outcome = await Promise.race([
    withdrawalStarted.promise.then(() => 'withdrawal'),
    inboxDone.then(() => 'done'),
  ]);

  expect(outcome).toBe('withdrawal');
  expect(existsSync(socketPath)).toBe(true);
  expect(await readLiveLockHolder(lockPath)).toBeDefined();

  releaseWithdrawal.resolve(undefined);
  await inboxDone;

  expect(existsSync(socketPath)).toBe(false);
  expect(await readLiveLockHolder(lockPath)).toBeDefined();

  await architectShutdown.handler({ reason: 'quit' } as never, context);

  expect(existsSync(socketPath)).toBe(false);
  expect(await readLiveLockHolder(lockPath)).toBeUndefined();
});

it('queues an answer before the inbox closes, then withdraws its socket and label', async ({
  onTestFinished,
}) => {
  const {
    root,
    sessionId,
    socketPath,
    calls,
    closeInbox,
    context,
    handoverStart,
    inboxStart,
    beforeInboxShutdown,
    check,
    request,
    queued,
    save,
  } = await setupAnswerScenario(onTestFinished);

  if (socketPath === undefined) {
    throw new Error('This test needs a POSIX user ID for the inbox socket path.');
  }

  expect(handoverStart.index).toBeLessThan(inboxStart.index);

  await handoverStart.handler({ type: 'session_start', reason: 'startup' } as never, context);
  await inboxStart.handler({ type: 'session_start', reason: 'startup' } as never, context);

  expect(existsSync(socketPath)).toBe(true);

  for (const shutdown of beforeInboxShutdown) {
    await shutdown.handler({ type: 'session_shutdown', reason: 'quit' } as never, context);
  }

  expect(await check(request, save)).toEqual(queued);

  expect(await readQuestionRecord(root, questionId)).toEqual({
    kind: 'record',
    record: {
      ...answerRecord(sessionId),
      state: 'answered',
      answer: 'Use option A.',
    },
  });

  await closeInbox();

  expect(existsSync(socketPath)).toBe(false);

  expect(calls).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        command: 'hc',
        commandArguments: ['label', '--json', '--', 't-worker', `${inboxLabelKey}=`],
      }),
    ]),
  );
});

it('sets the session directory before the inbox accepts answers', async ({ onTestFinished }) => {
  const { context, handoverStart, inboxStart, check, request, queued, save } =
    await setupAnswerScenario(onTestFinished);

  const starts = [handoverStart, inboxStart].toSorted((left, right) => left.index - right.index);
  const beforeInbox = starts.filter((start) => start.index < inboxStart.index);
  const fromInbox = starts.filter((start) => start.index >= inboxStart.index);

  expect(handoverStart.index).toBeLessThan(inboxStart.index);

  for (const start of beforeInbox) {
    await start.handler({ type: 'session_start', reason: 'startup' } as never, context);
  }

  expect(await check(request, save)).toEqual(queued);

  for (const start of fromInbox) {
    await start.handler({ type: 'session_start', reason: 'startup' } as never, context);
  }

  expect(await check(request, save)).toEqual(queued);
});
