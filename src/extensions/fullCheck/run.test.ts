import { onTestFinished, expect, it, vi } from 'vitest';

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

it('settles a cancelled run of a command that cannot spawn without signalling process group zero', async () => {
  const root = await createTemporaryRepository(onTestFinished, 'tau-full-check-run-');
  const killed: unknown[][] = [];

  vi.spyOn(process, 'kill').mockImplementation((...killArguments) => {
    killed.push(killArguments);

    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });

  onTestFinished(() => {
    vi.restoreAllMocks();
  });

  const controller = new AbortController();

  controller.abort();

  const outcome = runCheck(root, ['tau-no-such-command'], controller.signal, async () => {});

  await expect(outcome).rejects.toThrow('ENOENT');

  // The close event follows the error event.
  await new Promise((resolve) => {
    setTimeout(resolve, 100);
  });

  expect(killed.filter(([processId]) => processId === 0)).toEqual([]);
});
