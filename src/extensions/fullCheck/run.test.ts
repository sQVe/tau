import { onTestFinished, expect, it } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { groupIsAlive } from './queue.js';
import { runCheck } from './run.js';

const waitForGroupExit = async (groupId: number): Promise<void> => {
  while (groupIsAlive(groupId)) {
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
};

it('returns only after the command group is recorded, even when the command exits first', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  let recorded = false;

  const result = await runCheck(root, [process.execPath, '-e', ''], undefined, async (groupId) => {
    await waitForGroupExit(groupId);

    // Leaves time for a run that does not wait for the record to return first.
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    recorded = true;
  });

  expect(result.passed).toBe(true);
  expect(recorded).toBe(true);
});
