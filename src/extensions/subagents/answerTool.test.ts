import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { workerFixture } from './fixtures/routedLoadout.js';
import subagentsExtension, { registerCapacityRefusal } from './subagents.js';

const manager = 'manager';

const parameters = {
  assignmentId: '11111111-1111-4111-8111-111111111111',
  questionId: '22222222-2222-4222-8222-222222222222',
  answer: 'Use the second counter.',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const registerExtension = () => {
  const fake = createHcFake();
  const pi = fakeExtensionApi({ exec: fake.exec });

  subagentsExtension(pi.pi, registerCapacityRefusal(pi.pi));

  return { fake, pi };
};

it('registers subagent_answer for a manager before and after the session starts', async ({
  onTestFinished,
}) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const { pi } = registerExtension();

  expect(pi.tools.get('subagent_answer')?.exposure).toBe('model-only');

  pi.tools.clear();

  for (const handler of pi.handlers.get('session_start') ?? []) {
    await handler({} as never, fixture.context as unknown as ExtensionContext);
  }

  expect(pi.tools.get('subagent_answer')?.exposure).toBe('model-only');
});

it('does not register subagent_answer in a worker', () => {
  vi.stubEnv('TAU_ROLE', 'worker');

  const { pi } = registerExtension();

  expect(pi.tools.has('subagent_answer')).toBe(false);
});

it('refuses an answer without a saved parent session and calls no hc command', async ({
  onTestFinished,
}) => {
  vi.stubEnv('HC_TERMINAL_ID', manager);

  const fixture = await workerFixture(onTestFinished);
  const { fake, pi } = registerExtension();
  const tool = pi.tools.get('subagent_answer');

  if (tool === undefined) {
    throw new Error('The subagent_answer tool was not registered.');
  }

  const context = {
    ...fixture.context,
    sessionManager: { getSessionFile: () => undefined },
  } as unknown as ExtensionToolContext;

  await expect(tool.execute('call', parameters, undefined, undefined, context)).rejects.toThrow(
    'saved parent Pi session',
  );

  expect(fake.calls).toEqual([]);
});
