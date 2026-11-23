import { join } from 'node:path';

import type {
  ExtensionContext,
  ExtensionToolContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
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
import type { QuestionRecord } from './question/questionRecord.js';
import { writeQuestionRecord } from './question/questionRecord.js';

interface ContextOptions {
  entries?: readonly SessionEntry[];
  sessionId?: string;
  cwd?: string;
}

const contextFields = (options: ContextOptions) => ({
  cwd: options.cwd ?? '/repository',
  sessionManager: {
    getBranch: () => [],
    getEntries: () => options.entries ?? [],
    getSessionId: () => options.sessionId ?? 'session-1',
  },
});

const context = (options: ContextOptions = {}): ExtensionContext =>
  contextFields(options) as unknown as ExtensionContext;

const toolContext = (options: ContextOptions = {}): ExtensionToolContext =>
  contextFields(options) as unknown as ExtensionToolContext;

const answerQuestionId = '11111111-1111-4111-8111-111111111111';
const answerAskerSession = '22222222-2222-4222-8222-222222222222';
const answerSenderSession = '33333333-3333-4333-8333-333333333333';

afterEach(() => {
  vi.unstubAllEnvs();
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

it('looks up the question with a saved session ID', async () => {
  vi.stubEnv('TAU_ROLE', '');

  const fake = fakeExtensionApi();

  handoverQuestionExtension(fake.pi);

  const tool = fake.tools.get('handover_answer');

  if (tool === undefined) {
    throw new Error('Expected the handover_answer tool to be registered.');
  }

  const questionId = '11111111-1111-4111-8111-111111111111';

  const result = await tool.execute(
    'call-1',
    { questionId, answer: 'Use option A.' },
    undefined,
    undefined,
    toolContext({ sessionId: 'session-1' }),
  );

  expect(result.details).toMatchObject({ status: 'refused', questionId });
});

it('answers through the registered tool with the send runtime', async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const root = temporaryDirectory(onTestFinished, 'tau-handover-answer-');

  const asker = await startHandoverReceiver(onTestFinished, root, 'worker-1', {
    sessionId: answerAskerSession,
    accepts: { 'handover-answer': (_request, save) => save() },
  });

  const fake = createHcFake();

  advertiseInbox(fake, 'worker-1', asker.path);

  const extension = fakeExtensionApi({ exec: fake.exec });

  handoverQuestionExtension(extension.pi);

  const tool = extension.tools.get('handover_answer');

  if (tool === undefined) {
    throw new Error('Expected the handover_answer tool to be registered.');
  }

  const received: SessionEntry = {
    type: 'custom_message',
    customType: 'tau-inbox-message',
    content: `Handover question ${answerQuestionId} from terminal worker-1, session ${answerAskerSession}:\n\nWhich option should I use?`,
    display: true,
    details: {
      version: 4,
      messageId: answerQuestionId,
      sessionId: answerSenderSession,
      family: 'handover-question',
      questionId: answerQuestionId,
    },
  } as unknown as SessionEntry;

  const result = await tool.execute(
    'call-1',
    { questionId: answerQuestionId, answer: 'Use option A.' },
    undefined,
    undefined,
    toolContext({ entries: [received], sessionId: answerSenderSession }),
  );

  expect(result.details).toEqual({ status: 'queued', questionId: answerQuestionId });
  expect(savedFiles(asker)).toHaveLength(1);
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

const openAnswerRecord = (): QuestionRecord => ({
  version: 1,
  questionId: answerQuestionId,
  askerTerminal: 'worker-1',
  askerSession: answerAskerSession,
  senderTerminal: 'lead-1',
  senderSession: answerSenderSession,
  text: 'Which option should I use?',
  askedAt: '2026-11-18T12:00:00.000Z',
  state: 'open',
  answer: null,
});

const queuedAnswerReply: MessageReply = {
  protocol: 'rpc1',
  kind: 'queued',
  messageId: answerQuestionId,
  terminal: 'worker-1',
  sessionId: answerAskerSession,
};

it('reads the session cwd instead of the process cwd', async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const root = await createTemporaryRepository(onTestFinished);
  const processDirectory = temporaryDirectory(onTestFinished, 'tau-outside-repository-');
  const processCwd = vi.spyOn(process, 'cwd').mockReturnValue(processDirectory);

  onTestFinished(() => {
    processCwd.mockRestore();
    forgetAcceptCheck('handover-answer');
  });

  const fake = fakeExtensionApi();

  handoverQuestionExtension(fake.pi);

  const check = acceptChecks()['handover-answer'];

  if (check === undefined) {
    throw new Error('The extension registered no handover-answer check.');
  }

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toBe(
    'This session has not started, so it cannot accept a handover answer.',
  );

  await writeQuestionRecord(root, openAnswerRecord());

  await fake.handler('session_start')(
    { type: 'session_start', reason: 'startup' },
    context({ cwd: root, sessionId: answerAskerSession }),
  );

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

  for (const handler of fake.handlers.get('session_shutdown') ?? []) {
    await handler(
      { type: 'session_shutdown', reason: 'quit' } as never,
      context({ cwd: root, sessionId: answerAskerSession }),
    );
  }

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toEqual(
    queuedAnswerReply,
  );
});

it('reads the checkout of the next session start', async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const firstRoot = await createTemporaryRepository(onTestFinished);
  const secondRoot = await createTemporaryRepository(onTestFinished);
  const processDirectory = temporaryDirectory(onTestFinished, 'tau-outside-repository-');
  const processCwd = vi.spyOn(process, 'cwd').mockReturnValue(processDirectory);

  onTestFinished(() => {
    processCwd.mockRestore();
    forgetAcceptCheck('handover-answer');
  });

  const fake = fakeExtensionApi();

  handoverQuestionExtension(fake.pi);

  const check = acceptChecks()['handover-answer'];

  if (check === undefined) {
    throw new Error('The extension registered no handover-answer check.');
  }

  await writeQuestionRecord(firstRoot, openAnswerRecord());

  await fake.handler('session_start')(
    { type: 'session_start', reason: 'startup' },
    context({ cwd: firstRoot, sessionId: answerAskerSession }),
  );

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toEqual(
    queuedAnswerReply,
  );

  await fake.handler('session_start')(
    { type: 'session_start', reason: 'resume' },
    context({ cwd: secondRoot, sessionId: answerAskerSession }),
  );

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toBe(
    `This session asked no handover question ${answerQuestionId}.`,
  );

  await writeQuestionRecord(secondRoot, openAnswerRecord());

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toEqual(
    queuedAnswerReply,
  );
});
