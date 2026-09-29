import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../tests/extensionApi.js';
import { requireRegisteredTools } from './index.js';

const startSession = (worker: string) => {
  vi.stubEnv('TAU_WORKER_RECORD', worker);
  const fake = fakeExtensionApi({ getAllTools: () => [] });
  requireRegisteredTools(fake.pi, 'fixture-package', ['fixture_tool']);

  return () => {
    for (const handler of fake.handlers.get('session_start') ?? []) {
      handler(undefined as never, {} as ExtensionContext);
    }
  };
};

it('names a missing bundled tool in a parent session but leaves worker tools to the profile', ({
  onTestFinished,
}) => {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  expect(startSession('')).toThrow('"fixture_tool" is not registered');
  expect(startSession('/records/task')).not.toThrow();
});
