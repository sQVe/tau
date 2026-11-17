import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import architectExtension from './architect.js';

const registerSession = (cleanup: (cleanup: () => void) => void, role: 'lead' | 'architect') => {
  vi.stubEnv('TAU_ARCHITECT_ASK', '');
  vi.stubEnv('TAU_ROLE', role);

  cleanup(() => {
    vi.unstubAllEnvs();
  });

  const fake = fakeExtensionApi();

  architectExtension(fake.pi);

  return fake;
};

const receiveHandover = (
  fake: ReturnType<typeof fakeExtensionApi>,
  details: Record<string, unknown>,
): Mock<() => void> => {
  const shutdown = vi.fn<() => void>();
  const context = { shutdown } as unknown as ExtensionContext;

  for (const handler of fake.handlers.get('tool_result') ?? []) {
    handler({ toolName: 'handover', details } as never, context);
  }

  return shutdown;
};

it('a visible architect shuts down after a queued handover', ({ onTestFinished }) => {
  const fake = registerSession(onTestFinished, 'architect');
  const shutdown = receiveHandover(fake, { status: 'queued' });

  expect(shutdown).toHaveBeenCalledTimes(1);
});

it('a visible architect stays open after a handover with another status', ({ onTestFinished }) => {
  const fake = registerSession(onTestFinished, 'architect');
  const shutdown = receiveHandover(fake, { status: 'unknown' });

  expect(shutdown).not.toHaveBeenCalled();
});

it('a lead session does not shut down after a queued handover', ({ onTestFinished }) => {
  const fake = registerSession(onTestFinished, 'lead');
  const shutdown = receiveHandover(fake, { status: 'queued' });

  expect(shutdown).not.toHaveBeenCalled();
});
