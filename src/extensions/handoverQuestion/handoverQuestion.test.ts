import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { createHcFake } from '../../../tests/hcFake.js';
import handoverQuestionExtension from './handoverQuestion.js';

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

it('refuses to ask without a handover sender', async () => {
  const tool = await registeredTool();

  const execution = tool.execute(
    'call',
    { question },
    undefined,
    undefined,
    toolContext({ branch: branchWithoutSender }),
  );

  await expect(execution).rejects.toThrow('This session has no handover sender to ask.');
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

it('asks the sender once the sender, terminal, and session are known', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const fake = createHcFake();
  const tool = await registeredTool({ exec: fake.exec });

  vi.stubEnv('HC_TERMINAL_ID', 'worker-1');

  const result = await tool.execute(
    'call',
    { question },
    undefined,
    undefined,
    toolContext({ cwd: root }),
  );

  expect(result.details).toMatchObject({ status: 'refused' });
  expect(result.isError).toBe(true);
});
