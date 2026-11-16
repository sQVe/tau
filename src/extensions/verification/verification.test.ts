import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { findRunDirectory } from './verification.js';

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

  expect(await findRunDirectory(root, 'delegate-a-check')).toBe(
    join(root, '.tau', 'verification', 'delegate-a-check'),
  );
});
