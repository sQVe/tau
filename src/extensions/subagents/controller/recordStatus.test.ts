import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, vi, onTestFinished as afterTest } from 'vitest';

import { recordEvent } from '../records.js';
import type { TaskEvent } from '../types.js';
import { WorkerController } from './controller.js';
import { setup } from './fixtures/controllerFixture.js';
import { EvidenceUnavailableError, taskStatus } from './record.js';

const stopTime = async (records: readonly (readonly [TaskEvent['kind'], number])[]) => {
  const { controller, input } = setup(afterTest);
  const launched = await controller.launch(input);

  controller.close();
  vi.useFakeTimers({ toFake: ['Date'] });

  afterTest(() => {
    vi.useRealTimers();
  });

  for (const [kind, at] of records) {
    vi.setSystemTime(at);

    recordEvent(launched.directory, launched.taskId, kind, {
      detail: kind,
      stopped: true,
    });
  }

  return taskStatus(launched.directory);
};

it.each([
  [
    'the worker settled first',
    [
      ['settled', 1000],
      ['timeout', 2000],
      ['cancelled', 3000],
      ['cleanup', 4000],
    ],
    1000,
  ],
  [
    'the task timed out first',
    [
      ['timeout', 2000],
      ['cancelled', 3000],
      ['cleanup', 4000],
    ],
    2000,
  ],
  [
    'the task was cancelled first',
    [
      ['cancelled', 3000],
      ['cleanup', 4000],
    ],
    3000,
  ],
  ['only the cleanup record exists', [['cleanup', 4000]], 4000],
] as const)('reports the stop time when %s', async (_name, records, expected) => {
  const status = await stopTime(records);

  expect(status.state).toBe('stopped');
  expect(status.stoppedAt).toBe(expected);
});

it('reports no stop time while the worker is not stopped', async ({ onTestFinished }) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);

  expect(controller.status(launched.taskId, input.parentSessionId)).not.toHaveProperty('stoppedAt');
});

it('carries the task directory as recovery when the saved task cannot be read', async ({
  onTestFinished,
}) => {
  const { controller, input, directory } = setup(onTestFinished);
  const launched = await controller.launch(input);

  controller.close();
  writeFileSync(join(launched.directory, 'task.json'), '{');
  const recovered = new WorkerController(directory);

  onTestFinished(() => {
    recovered.close();
  });

  let failure: unknown;

  try {
    recovered.status(launched.taskId, input.parentSessionId);
  } catch (error) {
    failure = error;
  }

  expect(failure).toBeInstanceOf(EvidenceUnavailableError);

  expect((failure as EvidenceUnavailableError).recovery).toEqual({
    directory: launched.directory,
  });
});
