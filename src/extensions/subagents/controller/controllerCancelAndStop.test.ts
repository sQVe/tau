import { expect, it, vi } from 'vitest';

import { readEvent, readTask } from '../records.js';
import { WorkerCapacityFullError, WorkerController } from './controller.js';
import { completed, setup } from './fixtures/controllerFixture.js';

it('refuses to cancel once the parent controller closed', async ({ onTestFinished }) => {
  const { controller, input, calls } = setup(onTestFinished);
  const launched = await controller.launch(input);

  controller.close();
  const callsBefore = calls.length;

  await expect(controller.cancel(launched.taskId, 'parent-id')).rejects.toThrow(
    'Parent controller stopped',
  );

  expect(calls).toHaveLength(callsBefore);
});

it('reports a cleaned-up saved worker on cancel without stopping or owning it', async () => {
  const { controller, source, calls } = await completed();
  const callsBefore = calls.length;

  const status = await controller.cancel(source.taskId, 'parent-id');

  expect(status.state).toBe('stopped');
  expect(calls).toHaveLength(callsBefore);
  expect(controller.owns(source.taskId)).toBe(false);
});

it('owns a saved worker and reserves its slot while a cancel stops it', async ({
  onTestFinished,
}) => {
  vi.stubEnv('TAU_SUBAGENT_CAP', '1');
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);

  fixture.controller.close();

  const entered = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  let paused = false;

  const recovered = new WorkerController(
    fixture.directory,
    async (argumentsList, budget, signal) => {
      if (argumentsList[0] === 'pane' && argumentsList[1] === 'list' && !paused) {
        paused = true;
        entered.resolve(undefined);
        await release.promise;
      }

      return fixture.client(argumentsList, budget, signal);
    },
  );

  onTestFinished(() => {
    recovered.close();
  });

  const cancelling = recovered.cancel(launched.taskId, 'parent-id');
  await entered.promise;
  const owned = recovered.owns(launched.taskId);
  const refused = await recovered.launch(fixture.input).catch((error: unknown) => error);

  release.resolve(undefined);
  await cancelling;

  expect(owned).toBe(true);
  expect(refused).toBeInstanceOf(WorkerCapacityFullError);
});

it('records a cancellation for each worker when the parent session shuts down', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);

  await controller.stopAll();

  expect(readEvent(launched.directory, launched.taskId, 'cancelled')).toBeDefined();
});

it('records a timeout when it stops a saved worker whose deadline passed', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers();
  const fixture = setup(onTestFinished);
  const launched = await fixture.controller.launch(fixture.input);

  fixture.controller.close();
  await vi.advanceTimersByTimeAsync(20_000);

  const recovered = new WorkerController(fixture.directory, fixture.client);

  onTestFinished(() => {
    recovered.close();
  });

  await recovered.resume('parent-id');

  expect(readEvent(launched.directory, launched.taskId, 'timeout')).toBeDefined();
});

const failingLaunch = async (
  onTestFinished: (callback: () => void) => void,
  spendBudget: boolean,
) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  let recordDirectory = '';

  const { controller, input } = setup(onTestFinished, 0, async (argumentsList) => {
    if (argumentsList[0] === 'layout') {
      const root = (JSON.parse(argumentsList[2] ?? '') as { root: { env: Record<string, string> } })
        .root;

      recordDirectory = root.env.TAU_WORKER_RECORD ?? '';

      if (spendBudget) {
        vi.advanceTimersByTime(8000);
      }

      throw new Error('herdr failed');
    }

    return '';
  });

  // An unaffordable cleanup also leaves the status unreadable, so the launch may reject.
  await controller.launch(input).catch(() => undefined);

  return { directory: recordDirectory, taskId: readTask(recordDirectory).taskId };
};

it('records a timeout for a launch that fails after its budget is spent', async ({
  onTestFinished,
}) => {
  const { directory, taskId } = await failingLaunch(onTestFinished, true);

  expect(readEvent(directory, taskId, 'timeout')).toBeDefined();
});

it('records a startup failure, not a timeout, for a launch that fails within its budget', async ({
  onTestFinished,
}) => {
  const { directory, taskId } = await failingLaunch(onTestFinished, false);

  expect(readEvent(directory, taskId, 'startupFailure')).toBeDefined();
  expect(readEvent(directory, taskId, 'timeout')).toBeUndefined();
});
