import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import askUserQuestionExtension from '../src/extensions/askUserQuestion/askUserQuestion.js';
import handoverQuestionExtension from '../src/extensions/handoverQuestion/handoverQuestion.js';
import { acceptChecks } from '../src/inbox/inbox.js';
import { fakeExtensionApi } from './extensionApi.js';
import { forgetAcceptCheck } from './inboxReceiverHarness.js';

const context = (): ExtensionContext =>
  ({
    cwd: '/repository',
    sessionManager: { getBranch: () => [], getSessionId: () => 'session-1' },
  }) as unknown as ExtensionContext;

const registersAnswerTool = (role: string): boolean => {
  vi.stubEnv('TAU_ROLE', role);

  const fake = fakeExtensionApi();

  handoverQuestionExtension(fake.pi);

  return fake.tools.has('handover_answer');
};

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

it('registers handover_answer for a lead only', () => {
  expect({
    lead: registersAnswerTool(''),
    architect: registersAnswerTool('architect'),
    worker: registersAnswerTool('worker'),
  }).toEqual({ lead: true, architect: false, worker: false });
});
