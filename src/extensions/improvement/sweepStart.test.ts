import { expect, it, vi } from 'vitest';

import { declinedExec } from '../../../tests/declinedExecFake.js';
import type { SweepOptions, SweepOutcome } from '../../improvement/sweep.js';
import { createSweepLifecycle } from './sweepStart.js';

type SweepRunner = (options: SweepOptions) => Promise<SweepOutcome>;

const session = {
  cwd: '/work/me-1',
  agentDirectory: '/agent',
  exec: declinedExec,
};

it('runs the sweep with the default options', async () => {
  const runSweep = vi.fn<SweepRunner>(async () => ({ outcome: 'caughtUp' }));
  const lifecycle = createSweepLifecycle(runSweep);
  const refreshed = Promise.withResolvers<undefined>();

  lifecycle.start(session, async () => {
    refreshed.resolve(undefined);
  });

  expect(lifecycle.latest()).toBeUndefined();

  await refreshed.promise;

  expect(runSweep).toHaveBeenCalledWith(
    expect.objectContaining({
      agentDirectory: '/agent',
      cwd: '/work/me-1',
      exec: declinedExec,
      budgetMilliseconds: 20_000,
      since: '2026-04-09',
    }),
  );
});

it('records the outcome before it refreshes', async () => {
  const lifecycle = createSweepLifecycle(async () => ({ outcome: 'caughtUp' }));
  const refreshed = Promise.withResolvers<undefined>();
  let seenDuringRefresh: SweepOutcome | undefined;

  lifecycle.start(session, async () => {
    seenDuringRefresh = lifecycle.latest();
    refreshed.resolve(undefined);
  });

  await refreshed.promise;

  expect(seenDuringRefresh).toEqual({ outcome: 'caughtUp' });
});

it('records a failed outcome when the runner throws', async () => {
  const lifecycle = createSweepLifecycle(async () => {
    throw new Error('gh failed');
  });

  const refreshed = Promise.withResolvers<undefined>();

  lifecycle.start(session, async () => {
    refreshed.resolve(undefined);
  });

  await refreshed.promise;

  expect(lifecycle.latest()).toEqual({ outcome: 'failed', reason: 'gh failed' });
});

it('starts the run without waiting for it', () => {
  const pending = Promise.withResolvers<SweepOutcome>();
  const runSweep = vi.fn<SweepRunner>(() => pending.promise);
  const lifecycle = createSweepLifecycle(runSweep);

  lifecycle.start(session, async () => undefined);

  expect(runSweep).toHaveBeenCalledTimes(1);
});

it('keeps the previous result when a stopped run aborts', async () => {
  const first = Promise.withResolvers<SweepOutcome>();

  const runSweep = vi
    .fn<SweepRunner>()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(
      (options) =>
        new Promise((resolve) => {
          options.signal.addEventListener('abort', () => {
            resolve({ outcome: 'caughtUp' });
          });
        }),
    );

  const lifecycle = createSweepLifecycle(runSweep);
  const refreshed = Promise.withResolvers<undefined>();

  lifecycle.start(session, async () => {
    refreshed.resolve(undefined);
  });

  first.resolve({ outcome: 'caughtUp' });
  await refreshed.promise;

  lifecycle.start(session, async () => undefined);
  await lifecycle.stop();

  expect(lifecycle.latest()).toEqual({ outcome: 'caughtUp' });
});

it('awaits a refresh the completion path already started', async () => {
  const lifecycle = createSweepLifecycle(async () => ({ outcome: 'caughtUp' }));
  const refreshStarted = Promise.withResolvers<undefined>();
  const refreshFinished = Promise.withResolvers<undefined>();

  lifecycle.start(session, async () => {
    refreshStarted.resolve(undefined);
    await refreshFinished.promise;
  });

  await refreshStarted.promise;

  let stopped = false;

  const stopping = lifecycle.stop().then(() => {
    stopped = true;

    return undefined;
  });

  await Promise.resolve();

  expect(stopped).toBe(false);

  refreshFinished.resolve(undefined);
  await stopping;

  expect(stopped).toBe(true);
});

it('stops after the run finished', async () => {
  const lifecycle = createSweepLifecycle(async () => ({ outcome: 'caughtUp' }));
  const refreshed = Promise.withResolvers<undefined>();

  lifecycle.start(session, async () => {
    refreshed.resolve(undefined);
  });

  await refreshed.promise;
  await expect(lifecycle.stop()).resolves.toBeUndefined();

  expect(lifecycle.latest()).toEqual({ outcome: 'caughtUp' });
});

it('stops without a started sweep', async () => {
  const runSweep = vi.fn<SweepRunner>();
  const lifecycle = createSweepLifecycle(runSweep);

  await expect(lifecycle.stop()).resolves.toBeUndefined();

  expect(runSweep).not.toHaveBeenCalled();
});
