import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import architectExtension from './architect.js';

const registerVisibleArchitect = (cleanup: (cleanup: () => void) => void) => {
  vi.stubEnv('TAU_ARCHITECT_ASK', '');

  cleanup(() => {
    vi.unstubAllEnvs();
  });

  const fake = fakeExtensionApi();

  architectExtension(fake.pi);

  return fake;
};

it('a visible architect shuts down after a queued handover', ({ onTestFinished }) => {
  const fake = registerVisibleArchitect(onTestFinished);
  const shutdown = vi.fn<() => void>();

  fake.handler('tool_result')({ toolName: 'handover', details: { status: 'queued' } }, {
    shutdown,
  } as never);

  expect(shutdown).toHaveBeenCalledTimes(1);
});

it('a visible architect stays open after a handover with another status', ({ onTestFinished }) => {
  const fake = registerVisibleArchitect(onTestFinished);
  const shutdown = vi.fn<() => void>();

  fake.handler('tool_result')({ toolName: 'handover', details: { status: 'unknown' } }, {
    shutdown,
  } as never);

  expect(shutdown).not.toHaveBeenCalled();
});
