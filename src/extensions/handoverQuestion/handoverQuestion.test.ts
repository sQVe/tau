import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
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
import type { QuestionOutcome } from './question/question.js';
import type { QuestionRecord } from './question/questionRecord.js';
import {
  questionRecordDirectory,
  readQuestionRecord,
  writeQuestionRecord,
} from './question/questionRecord.js';

interface ContextOptions {
  branch?: unknown;
  sessionId?: string;
  cwd?: string;
}

const senderSession = '33333333-3333-4333-8333-333333333333';
const senderLine = `Handover sender: terminal lead-1, session ${senderSession}.`;

const branch = [
  {
    type: 'message',
    message: { role: 'user', content: `${senderLine}\n\nDo the work.` },
  },
];

const branchWithoutSender = [
  {
    type: 'message',
    message: { role: 'user', content: 'Do the work.' },
  },
];

const contextFields = (options: ContextOptions) => ({
  cwd: options.cwd ?? '/repository',
  sessionManager: {
    getBranch: () => options.branch ?? branch,
    getSessionId: () => options.sessionId ?? 'session-1',
  },
});

const context = (options: ContextOptions = {}): ExtensionContext =>
  contextFields(options) as unknown as ExtensionContext;

const toolContext = (options: ContextOptions = {}): ExtensionToolContext =>
  contextFields(options) as unknown as ExtensionToolContext;

const question = 'Which option should I use?';

const handoverText = (terminal: string, sessionId: string): string =>
  `Handover sender: terminal ${terminal}, session ${sessionId}.\n\nDo the work.`;

const handoverReceipt = (sessionId: string, version = 2) => ({
  version,
  messageId: '44444444-4444-4444-8444-444444444444',
  sessionId,
  family: 'handover',
});

const customEvent = (terminal: string, sessionId: string) => ({
  messageType: 'custom',
  message: {
    role: 'custom',
    customType: 'tau-inbox-message',
    content: handoverText(terminal, sessionId),
    display: true,
    details: handoverReceipt(sessionId),
    timestamp: 0,
  },
});

const handoverBranch = (terminal: string, sessionId: string) => [
  ...branchWithoutSender,
  {
    type: 'custom_message',
    customType: 'tau-inbox-message',
    content: handoverText(terminal, sessionId),
    display: true,
    details: handoverReceipt(sessionId, 3),
  },
];

const askerRecords = async (root: string): Promise<string[]> => {
  try {
    const names = await readdir(questionRecordDirectory(root));

    return names.filter((name) => name.endsWith('.json')).toSorted();
  } catch {
    return [];
  }
};

const startReceiver = async (terminal: string) => {
  const root = temporaryDirectory(onTestFinished, 'tau-handover-question-');

  const receiver = await startHandoverReceiver(onTestFinished, root, terminal, {
    outsideSlot: true,
    accepts: { 'handover-question': (_request, save) => save() },
  });

  return receiver;
};

const startAskerInbox = async (fake: ReturnType<typeof createHcFake>, sessionId: string) => {
  const root = temporaryDirectory(onTestFinished, 'tau-asker-inbox-');

  const inbox = await startHandoverReceiver(onTestFinished, root, 'worker-1', { sessionId });

  advertiseInbox(fake, 'worker-1', inbox.path);

  return inbox;
};

const registeredTool = async (overrides: Partial<ExtensionAPI> = {}) => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const fake = fakeExtensionApi(overrides);

  handoverQuestionExtension(fake.pi);
  await fake.handler('before_agent_start')({}, context());

  const tool = fake.tools.get('handover_question');

  if (tool === undefined) {
    throw new Error('Expected the handover_question tool to be registered.');
  }

  return tool;
};

afterEach(() => {
  vi.unstubAllEnvs();
});

it('registers the tool once a handover brings a sender', async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const registerTool = vi.fn<ExtensionAPI['registerTool']>();
  const overrides = { registerTool: registerTool as unknown as ExtensionAPI['registerTool'] };
  const fake = fakeExtensionApi(overrides);

  handoverQuestionExtension(fake.pi);

  const handler = fake.handler('before_agent_start');

  await handler({}, context());

  expect(registerTool).toHaveBeenCalledTimes(1);

  expect(registerTool.mock.calls[0]?.[0]).toMatchObject({
    name: 'handover_question',
    exposure: 'model-only',
  });

  await handler({}, context());

  expect(registerTool).toHaveBeenCalledTimes(1);
});

it('registers no tool when no handover sender starts the turn', async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const extension = fakeExtensionApi({ exec: fake.exec });

  handoverQuestionExtension(extension.pi);

  await extension.handler('before_agent_start')(
    {},
    context({ branch: branchWithoutSender, cwd: root }),
  );

  expect(extension.tools.has('handover_question')).toBe(false);
  expect(await askerRecords(root)).toEqual([]);
  expect(fake.calls).toHaveLength(0);
});

it('refuses to ask after switching to a branch with no sender', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const tool = await registeredTool({ exec: fake.exec });

  vi.stubEnv('HC_TERMINAL_ID', 'worker-1');

  const execution = tool.execute(
    'call',
    { question },
    undefined,
    undefined,
    toolContext({ branch: branchWithoutSender, cwd: root }),
  );

  await expect(execution).rejects.toBeInstanceOf(Error);

  expect(await askerRecords(root)).toEqual([]);
  expect(fake.calls).toHaveLength(0);
});

it('refuses to ask without a terminal address', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const tool = await registeredTool({ exec: fake.exec });

  vi.stubEnv('HC_TERMINAL_ID', '');

  const execution = tool.execute(
    'call',
    { question },
    undefined,
    undefined,
    toolContext({ cwd: root }),
  );

  await expect(execution).rejects.toBeInstanceOf(Error);

  expect(await askerRecords(root)).toEqual([]);
  expect(fake.calls).toHaveLength(0);
});

it('refuses to ask without a saved session ID', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const tool = await registeredTool({ exec: fake.exec });

  vi.stubEnv('HC_TERMINAL_ID', 'worker-1');

  const execution = tool.execute(
    'call',
    { question },
    undefined,
    undefined,
    toolContext({ cwd: root, sessionId: '' }),
  );

  await expect(execution).rejects.toBeInstanceOf(Error);

  expect(await askerRecords(root)).toEqual([]);
  expect(fake.calls).toHaveLength(0);
});

it('passes the call signal to the inbox send', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const receiverRoot = temporaryDirectory(onTestFinished, 'tau-handover-question-');

  const receiver = await startHandoverReceiver(onTestFinished, receiverRoot, 'lead-1', {
    outsideSlot: true,
    sessionId: senderSession,
    accepts: { 'handover-question': (_request, save) => save() },
  });

  advertiseInbox(fake, 'lead-1', receiver.path);
  await startAskerInbox(fake, 'session-1');

  const tool = await registeredTool({ exec: fake.exec });

  vi.stubEnv('HC_TERMINAL_ID', 'worker-1');

  const controller = new AbortController();

  const result = await tool.execute(
    'call',
    { question },
    controller.signal,
    undefined,
    toolContext({ cwd: root }),
  );

  const hcCalls = fake.calls.filter((call) => call.command === 'hc');

  expect(result.details).toMatchObject({ status: 'sent' });
  expect(hcCalls.length).toBeGreaterThan(0);
  expect(hcCalls.every((call) => call.signal === controller.signal)).toBe(true);
});

it('asks the sender that starts the turn with a custom message', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const askerSession = '11111111-1111-4111-8111-111111111111';
  const eventReceiver = await startReceiver('lead-1');
  const laterReceiver = await startReceiver('lead-2');

  advertiseInbox(fake, 'lead-1', eventReceiver.path);
  advertiseInbox(fake, 'lead-2', laterReceiver.path);
  await startAskerInbox(fake, askerSession);

  vi.stubEnv('HC_TERMINAL_ID', 'worker-1');
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const extension = fakeExtensionApi({ exec: fake.exec });

  handoverQuestionExtension(extension.pi);

  const handler = extension.handler('before_agent_start');

  await handler(
    customEvent('lead-1', eventReceiver.sessionId),
    context({ branch: branchWithoutSender, cwd: root, sessionId: askerSession }),
  );

  const tool = extension.tools.get('handover_question');

  if (tool === undefined) {
    throw new Error('Expected the handover_question tool to be registered.');
  }

  const first = await tool.execute(
    'call',
    { question },
    undefined,
    undefined,
    toolContext({
      branch: handoverBranch('lead-1', eventReceiver.sessionId),
      cwd: root,
      sessionId: askerSession,
    }),
  );

  const firstDetails = first.details as QuestionOutcome;

  expect(firstDetails).toMatchObject({ status: 'sent' });

  expect(await readQuestionRecord(root, firstDetails.questionId)).toMatchObject({
    kind: 'record',
    record: { senderTerminal: 'lead-1', senderSession: eventReceiver.sessionId },
  });

  const laterBranch = handoverBranch('lead-2', laterReceiver.sessionId);

  const second = await tool.execute(
    'call',
    { question },
    undefined,
    undefined,
    toolContext({ branch: laterBranch, cwd: root, sessionId: askerSession }),
  );

  const secondDetails = second.details as QuestionOutcome;

  expect(secondDetails).toMatchObject({ status: 'sent' });

  expect(await readQuestionRecord(root, secondDetails.questionId)).toMatchObject({
    kind: 'record',
    record: { senderTerminal: 'lead-2', senderSession: laterReceiver.sessionId },
  });

  expect(savedFiles(eventReceiver)).toHaveLength(1);
  expect(savedFiles(laterReceiver)).toHaveLength(1);
});

const answerQuestionId = '11111111-1111-4111-8111-111111111111';
const answerAskerSession = '22222222-2222-4222-8222-222222222222';
const answerSenderSession = '33333333-3333-4333-8333-333333333333';

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

  await fake.handler('session_shutdown')(
    { type: 'session_shutdown', reason: 'quit' },
    context({ cwd: root, sessionId: answerAskerSession }),
  );

  expect(await check(answerRequest(), () => Promise.resolve(queuedAnswerReply))).toBe(
    'This session has not started, so it cannot accept a handover answer.',
  );
});
