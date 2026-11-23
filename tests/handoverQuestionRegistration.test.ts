import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import askUserQuestionExtension from '../src/extensions/askUserQuestion/askUserQuestion.js';
import handoverQuestionExtension from '../src/extensions/handoverQuestion/handoverQuestion.js';
import { fakeExtensionApi } from './extensionApi.js';

const context = (): ExtensionContext =>
  ({
    cwd: '/repository',
    sessionManager: { getBranch: () => [], getSessionId: () => 'session-1' },
  }) as unknown as ExtensionContext;

afterEach(() => {
  vi.unstubAllEnvs();
});

it('registers no tool without a sender', async () => {
  vi.stubEnv('TAU_ROLE', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_TERMINAL', '');
  vi.stubEnv('TAU_HANDOVER_SENDER_SESSION', '');

  const fake = fakeExtensionApi();

  askUserQuestionExtension(fake.pi);
  handoverQuestionExtension(fake.pi);

  await fake.handler('before_agent_start')({}, context());

  expect(fake.tools.has('handover_question')).toBe(false);
  expect(fake.tools.has('ask_user_question')).toBe(true);
});
