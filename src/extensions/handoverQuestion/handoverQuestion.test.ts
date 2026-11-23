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
  savedFiles,
  startHandoverReceiver,
} from '../../../tests/inboxReceiverHarness.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import handoverQuestionExtension from './handoverQuestion.js';
import type { QuestionOutcome } from './question/question.js';
import { readQuestionRecord } from './question/questionRecord.js';

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

const handoverReceipt = (sessionId: string) => ({
  version: 2,
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
    details: handoverReceipt(sessionId),
  },
];

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

  const fake = fakeExtensionApi();

  handoverQuestionExtension(fake.pi);

  await fake.handler('before_agent_start')({}, context({ branch: branchWithoutSender }));

  expect(fake.tools.has('handover_question')).toBe(false);
});

it('refuses to ask without a terminal address', async () => {
  const tool = await registeredTool();

  vi.stubEnv('HC_TERMINAL_ID', '');

  const execution = tool.execute('call', { question }, undefined, undefined, toolContext());

  await expect(execution).rejects.toThrow('This session has no terminal address to ask from.');
});

it('refuses to ask without a saved session ID', async () => {
  const tool = await registeredTool();

  vi.stubEnv('HC_TERMINAL_ID', 'worker-1');

  const execution = tool.execute(
    'call',
    { question },
    undefined,
    undefined,
    toolContext({ sessionId: '' }),
  );

  await expect(execution).rejects.toThrow('This session has no saved Pi session ID to ask from.');
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
    toolContext({ branch: branchWithoutSender, cwd: root, sessionId: askerSession }),
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
