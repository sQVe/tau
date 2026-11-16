import { afterEach, expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import verificationExtension from './verification.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

it('registers the verification tool in a manager', () => {
  vi.stubEnv('TAU_ROLE', undefined);
  const fake = fakeExtensionApi();

  verificationExtension(fake.pi);

  expect(fake.tools.has('verification')).toBe(true);
});

it('registers no verification tool in a worker', () => {
  vi.stubEnv('TAU_ROLE', 'worker');
  const fake = fakeExtensionApi();

  verificationExtension(fake.pi);

  expect(fake.tools.has('verification')).toBe(false);
});
