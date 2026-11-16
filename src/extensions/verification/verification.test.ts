import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import verificationExtension, { findRunDirectory } from './verification.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const failureMessage = async (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'no error',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

it.each(['../run', 'a/b'])('refuses run name %s', async (run) => {
  const root = await createTemporaryRepository(onTestFinished);

  expect(await failureMessage(findRunDirectory(root, run))).toBe(
    `Run name ${run} is not a verification run name.`,
  );
});

it('finds the run directory below .tau/verification', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  expect(await findRunDirectory(root, 'delegate-a-check')).toEqual({
    root,
    directory: join(root, '.tau', 'verification', 'delegate-a-check'),
  });
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
