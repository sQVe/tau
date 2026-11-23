import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { architectLockPath } from '../src/extensions/architect/lock.js';
import type { QuestionRecord } from '../src/extensions/handoverQuestion/question/questionRecord.js';
import { writeQuestionRecord } from '../src/extensions/handoverQuestion/question/questionRecord.js';
import { readLiveLockHolder } from '../src/fileLock/fileLock.js';
import { socketDirectoryFor, socketPathFor } from '../src/inbox/endpoint.js';
import { acceptChecks } from '../src/inbox/inbox.js';
import type { MessageReply, MessageRequest } from '../src/inbox/protocol.js';
import tauRegistration from '../src/tau/tau.js';
import { succeededResult } from './execFake.js';
import { fakeExtensionApi } from './extensionApi.js';
import { createTemporaryRepository } from './gitRepository.js';
import { forgetAcceptCheck } from './inboxReceiverHarness.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

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

const answerQuestionId = '11111111-1111-4111-8111-111111111111';
const answerSenderSession = '33333333-3333-4333-8333-333333333333';

const answerRecord = (sessionId: string): QuestionRecord => ({
  version: 1,
  questionId: answerQuestionId,
  askerTerminal: 't-worker',
  askerSession: sessionId,
  senderTerminal: 'lead-1',
  senderSession: answerSenderSession,
  text: 'Which option should I use?',
  askedAt: '2026-11-18T12:00:00.000Z',
  state: 'open',
  answer: null,
});

const answerRequest = (sessionId: string): MessageRequest => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId: answerQuestionId,
  targetTerminal: 't-worker',
  targetSessionId: sessionId,
  family: 'handover-answer',
  payload: {
    questionId: answerQuestionId,
    senderSession: answerSenderSession,
    answer: 'Use option A.',
  },
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

it('sets the session directory before the inbox accepts answers', async ({ onTestFinished }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-answer-order-');
  const outside = temporaryDirectory(onTestFinished, 'tau-outside-repository-');
  const sessionId = randomUUID();
  const processGroup = 100;
  const processCwd = vi.spyOn(process, 'cwd').mockReturnValue(outside);

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');
  vi.stubEnv('HC_TERMINAL_ID', 't-worker');

  const fake = fakeExtensionApi({
    exec: async (command) => {
      if (command === 'ps') {
        return succeededResult(`${String(processGroup)}\n`);
      }

      const labels = { 'tau.inbox': 'rpc1:/tmp/unused.sock' };
      const foreground = { pid: processGroup, name: 'pi', argv: ['pi'], cwd: root };
      const terminal = { address: 't-worker', state: 'live', foreground, labels };

      return succeededResult(JSON.stringify(terminal));
    },
  });

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

  await writeQuestionRecord(root, answerRecord(sessionId));

  const check = acceptChecks()['handover-answer'];

  if (check === undefined) {
    throw new Error('Tau registered no handover-answer check.');
  }

  const request = answerRequest(sessionId);

  const queued: MessageReply = {
    protocol: 'rpc1',
    kind: 'queued',
    messageId: answerQuestionId,
    terminal: 't-worker',
    sessionId,
  };

  const save = () => Promise.resolve(queued);

  const context = {
    cwd: root,
    ui: { notify: vi.fn<(message: string, level?: string) => void>() },
    shutdown: vi.fn<() => void>(),
    isProjectTrusted: (): boolean => true,
    sessionManager: {
      getSessionFile: () => join(root, 'answer-session.jsonl'),
      getSessionId: () => sessionId,
      getEntries: () => [],
    },
  } as unknown as ExtensionContext;

  onTestFinished(async () => {
    processCwd.mockRestore();
    vi.unstubAllEnvs();
    forgetAcceptCheck('handover-answer');
    forgetAcceptCheck('handover-question');
    await inboxShutdown.handler({ type: 'session_shutdown', reason: 'quit' } as never, context);
  });

  const starts = [handoverStart, inboxStart].toSorted((left, right) => left.index - right.index);
  const beforeInbox = starts.filter((start) => start.index < inboxStart.index);
  const fromInbox = starts.filter((start) => start.index >= inboxStart.index);

  for (const start of beforeInbox) {
    await start.handler({ type: 'session_start', reason: 'startup' } as never, context);
  }

  expect(await check(request, save)).toEqual(queued);

  for (const start of fromInbox) {
    await start.handler({ type: 'session_start', reason: 'startup' } as never, context);
  }

  expect(await check(request, save)).toEqual(queued);
});
