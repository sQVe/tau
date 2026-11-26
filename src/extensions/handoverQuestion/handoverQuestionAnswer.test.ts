import { join } from 'node:path';

import type {
  ExtensionContext,
  ExtensionToolContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi, fakeExtensionContext } from '../../../tests/extensionApi.js';
import type { FakeExtensionContextOptions } from '../../../tests/extensionApi.js';
import { openRecord } from '../../../tests/fixtures/answerRecord.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import {
  advertiseInbox,
  forgetAcceptCheck,
  savedFiles,
  startHandoverReceiver,
} from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { acceptChecks, createReceiptStore, createReceiver } from '../../inbox/inbox.js';
import type { MessageReply, MessageRequest } from '../../inbox/protocol.js';
import handoverQuestionExtension from './handoverQuestion.js';
import { writeQuestionRecord } from './question/questionRecord.js';

const context = (options: FakeExtensionContextOptions = {}): ExtensionContext =>
  fakeExtensionContext(options);

const toolContext = (options: FakeExtensionContextOptions = {}): ExtensionToolContext =>
  fakeExtensionContext(options) as ExtensionToolContext;

const answerQuestionId = '11111111-1111-4111-8111-111111111111';
const otherLeadSession = '44444444-4444-4444-8444-444444444444';
const answerAskerSession = '22222222-2222-4222-8222-222222222222';
const answerSenderSession = '33333333-3333-4333-8333-333333333333';

const receivedEntry = (leadSession: string): SessionEntry =>
  ({
    type: 'custom_message',
    customType: 'tau-inbox-message',
    content: `Handover question ${answerQuestionId} from terminal worker-1, session ${answerAskerSession}:\n\nWhich option should I use?`,
    display: true,
    details: {
      version: 4,
      messageId: answerQuestionId,
      sessionId: leadSession,
      family: 'handover-question',
      questionId: answerQuestionId,
    },
  }) as unknown as SessionEntry;

const startAnswerTool = async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const root = temporaryDirectory(onTestFinished, 'tau-handover-answer-');
  const received: MessageRequest[] = [];

  const asker = await startHandoverReceiver(onTestFinished, root, 'worker-1', {
    sessionId: answerAskerSession,
    accepts: {
      'handover-answer': (request, save) => {
        received.push(request);

        return save();
      },
    },
  });

  const fake = createHcFake();

  advertiseInbox(fake, 'worker-1', asker.path);

  const extension = fakeExtensionApi({ exec: fake.exec });

  handoverQuestionExtension(extension.pi);

  const tool = extension.tools.get('handover_answer');

  if (tool === undefined) {
    throw new Error('Expected the handover_answer tool to be registered.');
  }

  return { asker, fake, received, tool };
};

// The send resolves the asker with `hc get` before it opens any socket, so no lookup means no
// transport attempt.
const askerLookups = (fake: ReturnType<typeof createHcFake>): number =>
  fake.calls.filter(
    (call) =>
      call.command === 'hc' &&
      call.commandArguments[0] === 'get' &&
      call.commandArguments.at(-1) === 'worker-1',
  ).length;

afterEach(() => {
  vi.unstubAllEnvs();
  forgetAcceptCheck('handover-question');
  forgetAcceptCheck('handover-answer');
});

it('forgets both accept checks after the test', () => {
  vi.stubEnv('TAU_ROLE', '');

  handoverQuestionExtension(fakeExtensionApi().pi);

  onTestFinished(() => {
    expect(acceptChecks()['handover-question']).toBeUndefined();
    expect(acceptChecks()['handover-answer']).toBeUndefined();
  });
});

it('refuses to answer without a saved session ID', async () => {
  vi.stubEnv('TAU_ROLE', '');

  const fake = fakeExtensionApi();

  handoverQuestionExtension(fake.pi);

  const tool = fake.tools.get('handover_answer');

  if (tool === undefined) {
    throw new Error('Expected the handover_answer tool to be registered.');
  }

  await expect(
    tool.execute(
      'call-1',
      { questionId: '11111111-1111-4111-8111-111111111111', answer: 'Use option A.' },
      undefined,
      undefined,
      toolContext({ sessionId: '' }),
    ),
  ).rejects.toThrow('no saved Pi session ID');
});

it('refuses a question a different lead session received without sending', async () => {
  const { asker, fake, received, tool } = await startAnswerTool();

  const result = await tool.execute(
    'call-1',
    { questionId: answerQuestionId, answer: 'Use option A.' },
    undefined,
    undefined,
    toolContext({ branch: [receivedEntry(otherLeadSession)], sessionId: answerSenderSession }),
  );

  expect(result.isError).toBe(true);

  expect(result.details).toMatchObject({
    status: 'refused',
    questionId: answerQuestionId,
    reason: expect.stringContaining('never received') as string,
  });

  expect(askerLookups(fake)).toBe(0);
  expect(received).toEqual([]);
  expect(savedFiles(asker)).toEqual([]);
});

it('answers through the registered tool with the send runtime', async () => {
  const { asker, fake, received, tool } = await startAnswerTool();

  const result = await tool.execute(
    'call-1',
    { questionId: answerQuestionId, answer: 'Use option A.' },
    undefined,
    undefined,
    toolContext({ branch: [receivedEntry(answerSenderSession)], sessionId: answerSenderSession }),
  );

  expect(result.details).toEqual({ status: 'queued', questionId: answerQuestionId });
  expect(askerLookups(fake)).toBe(1);
  expect(received).toHaveLength(1);
  expect(savedFiles(asker)).toHaveLength(1);
});

it('refuses a question received only on another branch', async () => {
  const { asker, fake, received, tool } = await startAnswerTool();

  const result = await tool.execute(
    'call-1',
    { questionId: answerQuestionId, answer: 'Use option A.' },
    undefined,
    undefined,
    toolContext({
      entries: [receivedEntry(answerSenderSession)],
      branch: [],
      sessionId: answerSenderSession,
    }),
  );

  expect(result.isError).toBe(true);

  expect(result.details).toMatchObject({
    status: 'refused',
    questionId: answerQuestionId,
    reason: expect.stringContaining('never received') as string,
  });

  expect(askerLookups(fake)).toBe(0);
  expect(received).toEqual([]);
  expect(savedFiles(asker)).toEqual([]);
});

const answerRequest = (): MessageRequest => ({
  protocol: 'rpc1',
  kind: 'message',
  messageId: answerQuestionId,
  targetTerminal: 'worker-1',
  targetSessionId: answerAskerSession,
  family: 'handover-answer',
  payload: {
    questionId: answerQuestionId,
    senderSession: answerSenderSession,
    answer: 'Use option A.',
  },
});

const queuedAnswerReply: MessageReply = {
  protocol: 'rpc1',
  kind: 'queued',
  messageId: answerQuestionId,
  terminal: 'worker-1',
  sessionId: answerAskerSession,
};

const answerSessionFixture = async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const root = await createTemporaryRepository(onTestFinished);
  const processDirectory = temporaryDirectory(onTestFinished, 'tau-outside-repository-');
  const processCwd = vi.spyOn(process, 'cwd').mockReturnValue(processDirectory);

  onTestFinished(() => {
    processCwd.mockRestore();
  });

  const fake = fakeExtensionApi();

  handoverQuestionExtension(fake.pi);

  const check = acceptChecks()['handover-answer'];

  if (check === undefined) {
    throw new Error('The extension registered no handover-answer check.');
  }

  const startSession = async (reason: 'startup' | 'resume', cwd: string): Promise<void> => {
    await fake.handler('session_start')(
      { type: 'session_start', reason },
      context({ cwd, sessionId: answerAskerSession }),
    );
  };

  const shutdown = async (): Promise<void> => {
    const handlers = fake.handlers.get('session_shutdown') ?? [];

    expect(handlers).not.toHaveLength(0);

    for (const handler of handlers) {
      await handler(
        { type: 'session_shutdown', reason: 'quit' } as never,
        context({ cwd: root, sessionId: answerAskerSession }),
      );
    }
  };

  return { root, check, startSession, shutdown };
};

it('reads the session cwd instead of the process cwd', async () => {
  const { root, check, startSession } = await answerSessionFixture();

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toBe(
    'This session has not started, so it cannot accept a handover answer.',
  );

  await writeQuestionRecord(root, openRecord(answerSenderSession));
  await startSession('startup', root);

  const inboxRoot = temporaryDirectory(onTestFinished, 'tau-answer-inbox-');

  const receiver = createReceiver({
    directory: join(inboxRoot, answerAskerSession),
    terminal: 'worker-1',
    sessionId: answerAskerSession,
    accepts: { 'handover-answer': check },
    receipts: createReceiptStore(answerAskerSession),
    entries: () => [],
    wake: () => true,
    notify: () => undefined,
  });

  expect(await receiver.accept(answerRequest())).toEqual(queuedAnswerReply);
});

it('forgets the session cwd on shutdown', async () => {
  const { root, check, startSession, shutdown } = await answerSessionFixture();

  await writeQuestionRecord(root, openRecord(answerSenderSession));
  await startSession('startup', root);

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toEqual(
    queuedAnswerReply,
  );

  await shutdown();

  const save = vi.fn<() => Promise<MessageReply>>(async () => queuedAnswerReply);

  expect(await check(answerRequest(), save)).toContain('has not started');
  expect(save).not.toHaveBeenCalled();
});

it('reads the checkout of the next session start', async () => {
  const { root: firstRoot, check, startSession } = await answerSessionFixture();
  const secondRoot = await createTemporaryRepository(onTestFinished);

  await writeQuestionRecord(firstRoot, openRecord(answerSenderSession));
  await startSession('startup', firstRoot);

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toEqual(
    queuedAnswerReply,
  );

  await startSession('resume', secondRoot);

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toBe(
    `This session asked no handover question ${answerQuestionId}.`,
  );

  await writeQuestionRecord(secondRoot, openRecord(answerSenderSession));

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toEqual(
    queuedAnswerReply,
  );
});
