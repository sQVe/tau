import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import handoverQuestionExtension from './handoverQuestion.js';

const senderSession = '33333333-3333-4333-8333-333333333333';
const senderLine = `Handover sender: terminal lead-1, session ${senderSession}.`;

const branch = [
  {
    type: 'message',
    message: { role: 'user', content: `${senderLine}\n\nDo the work.` },
  },
];

const context = (): ExtensionContext =>
  ({
    cwd: '/repository',
    sessionManager: { getBranch: () => branch, getSessionId: () => 'session-1' },
  }) as unknown as ExtensionContext;

afterEach(() => {
  vi.unstubAllEnvs();
});

it('registers the tool once a handover brings a sender', async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const registerTool = vi.fn<ExtensionAPI['registerTool']>();
  // SAFETY: The mock records calls only; it never uses the tool's generic renderers.
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
