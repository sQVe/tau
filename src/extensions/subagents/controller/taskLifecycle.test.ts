import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { expect, it, vi } from 'vitest';

import { readEvent, recordEvent } from '../records.js';
import { setup } from './fixtures/controllerFixture.js';

// Cleanup waits on real timers, so only the controller's own timers are faked.
const fakeControllerTimers = () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
};

it.each(['settled', 'startupFailure'] as const)(
  'starts stopping a worker that saved a %s record',
  async (kind) => {
    fakeControllerTimers();
    const { controller, input } = setup(() => undefined);
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

it('gives a worker that finished a moment to exit before closing its pane', async () => {
  fakeControllerTimers();
  const { controller, input, fake, calls } = setup(() => undefined);
  const launched = await controller.launch(input);

  recordEvent(launched.directory, launched.taskId, 'settled', {
    detail: 'Done.',
    stopped: false,
  });

  await vi.advanceTimersByTimeAsync(300);
  await sleep(150);
  fake.state.stopped = true;

  await vi.waitFor(() => {
    expect(readEvent(launched.directory, launched.taskId, 'cleanup')?.stopped).toBe(true);
  });

  expect(calls.filter((call) => call[1] === 'close')).toHaveLength(0);
  controller.close();
});

it('stops a worker and records a failure when its evidence cannot be read while polling', async () => {
  fakeControllerTimers();
  const { controller, input, fake } = setup(() => undefined);
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

it('keeps a worker running when the launch signal aborts after the launch returned', async () => {
  fakeControllerTimers();
  const { controller, input, fake } = setup(() => undefined);
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

    return Promise.resolve(undefined);
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
