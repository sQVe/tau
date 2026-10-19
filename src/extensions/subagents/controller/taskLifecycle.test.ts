import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished as afterTest, vi } from 'vitest';

import { readEvent, recordEvent } from '../records.js';
import { renameBudget } from './budget.js';
import { captureError, setup } from './fixtures/controllerFixture.js';
import * as stopModule from './stop.js';

// Cleanup waits on real timers, so only the controller's own timers are faked.
const fakeControllerTimers = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
};

it.each(['settled', 'startupFailure'] as const)(
  'starts stopping a worker that saved a %s record',
  async (kind) => {
    fakeControllerTimers();
    const { controller, input } = setup(afterTest);
    const launched = await controller.launch(input);

    recordEvent(launched.directory, launched.taskId, kind, {
      detail: 'Done.',
      stopped: false,
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(readEvent(launched.directory, launched.taskId, 'stopping')).toBeDefined();
    controller.close();
  },
);

it('gives a worker that finished a moment to exit before closing its pane', async ({
  onTestFinished,
}) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  let polling = false;
  let polls = 0;

  const { controller, input, fake, calls } = setup(onTestFinished, 0, (argumentsList) => {
    if (polling && argumentsList[0] === 'pane' && argumentsList[1] === 'list') {
      polls += 1;

      // Listings: locate the pane, poll, then a later poll after a close would have started.
      if (polls === 4) {
        fake.state.stopped = true;
      }
    }

    return Promise.resolve('');
  });

  const launched = await controller.launch(input);

  polling = true;

  recordEvent(launched.directory, launched.taskId, 'settled', {
    detail: 'Done.',
    stopped: false,
  });

  await vi.advanceTimersByTimeAsync(300);

  await vi.waitFor(() => {
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  });

  expect(polls).toBeGreaterThanOrEqual(4);
  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(0);
});

it('stops a worker and records a failure when its evidence cannot be read while polling', async ({
  onTestFinished,
}) => {
  fakeControllerTimers();
  const { controller, input, fake } = setup(onTestFinished);
  const launched = await controller.launch(input);

  writeFileSync(join(launched.directory, 'settled.json'), '{');
  await vi.advanceTimersByTimeAsync(300);

  await vi.waitFor(() => {
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')).toBeDefined();
  });

  const failure = readEvent(launched.directory, launched.taskId, 'startupFailure');

  expect(failure?.detail).not.toBe('');
  expect(fake.state.stopped).toBe(true);
  controller.close();
});

it('keeps a worker running when the launch signal aborts after the launch returned', async ({
  onTestFinished,
}) => {
  fakeControllerTimers();
  const { controller, input, fake } = setup(onTestFinished);
  const launchAbort = new AbortController();
  const launched = await controller.launch(input, launchAbort.signal);

  launchAbort.abort();
  await vi.advanceTimersByTimeAsync(300);

  expect(readEvent(launched.directory, launched.taskId, 'cancelled')).toBeUndefined();
  expect(readEvent(launched.directory, launched.taskId, 'stopping')).toBeUndefined();
  expect(fake.state.stopped).toBe(false);
  expect(controller.owns(launched.taskId)).toBe(true);
  controller.close();
});

it('gives the pane rename more than a millisecond of herdr budget', async ({ onTestFinished }) => {
  const budgets: number[] = [];

  const { controller, input } = setup(onTestFinished, 0, (argumentsList, budget) => {
    if (argumentsList[0] === 'pane' && argumentsList[1] === 'rename') {
      budgets.push(budget);
    }

    return Promise.resolve('');
  });

  await controller.launch(input);

  expect(budgets).toHaveLength(1);
  expect(budgets[0]).toBeGreaterThan(1);
  controller.close();
});

it('reports every record error from a stop that could not save its records', async ({
  onTestFinished,
}) => {
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);

  chmodSync(launched.directory, 0o500);

  onTestFinished(() => {
    chmodSync(launched.directory, 0o700);
  });

  const failure = await controller
    .cancel(launched.taskId, input.parentSessionId)
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  // One error each for the stopping, cancelled, and cleanup records.
  expect((failure as Error).message.match(/EACCES/g)).toHaveLength(3);
});

it('gives the pane rename no more than its own herdr budget', async ({ onTestFinished }) => {
  const budgets: number[] = [];

  const { controller, input } = setup(onTestFinished, 0, (argumentsList, budget) => {
    if (argumentsList[0] === 'pane' && argumentsList[1] === 'rename') {
      budgets.push(budget);
    }

    return Promise.resolve('');
  });

  await controller.launch(input);

  expect(budgets).toHaveLength(1);
  expect(budgets[0]).toBeLessThanOrEqual(renameBudget);
});

it('stops the worker timers when it is cancelled', async ({ onTestFinished }) => {
  fakeControllerTimers();
  const { controller, input } = setup(onTestFinished);
  const launched = await controller.launch(input);

  expect(vi.getTimerCount()).toBeGreaterThan(0);

  await controller.cancel(launched.taskId, input.parentSessionId);

  expect(vi.getTimerCount()).toBe(0);
});

it('describes a stop for a failed worker with the failure and a stop for another reason without it', async ({
  onTestFinished,
}) => {
  fakeControllerTimers();
  const failing = setup(onTestFinished);
  const failed = await failing.controller.launch(failing.input);

  writeFileSync(join(failed.directory, 'settled.json'), '{');
  await vi.advanceTimersByTimeAsync(300);

  await vi.waitFor(() => {
    expect(readEvent(failed.directory, failed.taskId, 'cleanup')).toBeDefined();
  });

  const failure = readEvent(failed.directory, failed.taskId, 'startupFailure');
  const failedCleanup = readEvent(failed.directory, failed.taskId, 'cleanup');

  expect(failure?.detail).toBeTruthy();
  const failedNotice = failing.notifications.at(-1)?.details as { evidenceError: string };

  expect(failedNotice.evidenceError).toContain(`${failedCleanup?.detail} ${failure?.detail}`);

  const cancelling = setup(onTestFinished);
  const launched = await cancelling.controller.launch(cancelling.input);

  const status = await cancelling.controller.cancel(
    launched.taskId,
    cancelling.input.parentSessionId,
  );

  const cancelledCleanup = readEvent(launched.directory, launched.taskId, 'cleanup');

  expect(readEvent(launched.directory, launched.taskId, 'startupFailure')).toBeUndefined();
  expect(status.cleanup).toBe(cancelledCleanup?.detail);

  expect(cancelling.notifications.at(-1)?.details).toMatchObject({
    cleanup: cancelledCleanup?.detail,
  });
});

it('keeps the startup failure a worker saved when the parent also fails to read its evidence', async ({
  onTestFinished,
}) => {
  fakeControllerTimers();
  const { controller, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);

  recordEvent(launched.directory, launched.taskId, 'startupFailure', 'The worker could not start.');
  writeFileSync(join(launched.directory, 'settled.json'), '{');
  await vi.advanceTimersByTimeAsync(300);

  await vi.waitFor(() => {
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')).toBeDefined();
  });

  const failure = readEvent(launched.directory, launched.taskId, 'startupFailure');

  expect(failure?.detail).toBe('The worker could not start.');
  expect(JSON.stringify(notifications.at(-1)?.details)).not.toContain('EEXIST');
});

it('reports each distinct error from a background stop whose notices keep failing', async ({
  onTestFinished,
}) => {
  fakeControllerTimers();
  const { controller, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  let sequence = 0;

  vi.spyOn(notifications, 'push').mockImplementation(() => {
    sequence += 1;

    throw new Error(`notice ${sequence}`);
  });

  writeFileSync(join(launched.directory, 'settled.json'), '{');
  await vi.advanceTimersByTimeAsync(300);

  await vi.waitFor(() => {
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')).toBeDefined();
  });

  const failure = captureError(() => controller.status(launched.taskId, input.parentSessionId));

  expect(String(failure)).toContain('notice 1');
  expect(String(failure)).toContain('notice 2');
});

it('records a cleanup that failed and reports it while the parent is open', async ({
  onTestFinished,
}) => {
  fakeControllerTimers();
  const { controller, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);

  vi.spyOn(stopModule, 'stopPiWorker').mockRejectedValue(new Error('cleanup exploded'));
  await controller.cancel(launched.taskId, input.parentSessionId).catch(() => undefined);

  const failure = captureError(() => controller.status(launched.taskId, input.parentSessionId));

  expect(String(failure)).toContain('cleanup exploded');
  expect(notifications.length).toBeGreaterThan(0);
});

it('sends no notice for a cleanup that failed after the parent closed', async ({
  onTestFinished,
}) => {
  fakeControllerTimers();
  const { controller, input, notifications } = setup(onTestFinished);
  const launched = await controller.launch(input);
  const cleanup = Promise.withResolvers<never>();

  vi.spyOn(stopModule, 'stopPiWorker').mockReturnValue(cleanup.promise);

  const cancelling = controller
    .cancel(launched.taskId, input.parentSessionId)
    .catch(() => undefined);

  controller.close();
  cleanup.reject(new Error('cleanup exploded'));
  await cancelling;

  expect(notifications).toHaveLength(0);
});

it('keeps the name of a worker in its tab label when its cleanup failed', async ({
  onTestFinished,
}) => {
  const { controller, input, calls } = setup(onTestFinished, 0);

  await controller.launch(input);
  const second = await controller.launch(input);

  await controller.launch(input);
  vi.spyOn(stopModule, 'stopPiWorker').mockRejectedValue(new Error('cleanup exploded'));
  const before = calls.length;

  await controller.cancel(second.taskId, input.parentSessionId).catch(() => undefined);

  expect(calls.slice(before).filter((call) => call[0] === 'tab')).toEqual([]);
});
