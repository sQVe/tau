import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useFakeStartProcess } from '../../../../tests/startTicketFake.js';
import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { openTool, requestFor } from '../fixtures/openHarness.js';
import { recordSession, setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';
import { acquireStartFence } from '../startFence/startFence.js';
import type * as StartFenceModule from '../startFence/startFence.js';
import { openArchitect, takeoverExpiryError } from './open.js';

const poll = vi.hoisted(() => ({ started: Promise.withResolvers<undefined>() }));

vi.mock(import('node:timers/promises'), async (importOriginal) => {
  const original = await importOriginal();
  const { globalTimerDelay } = await import('../../../../tests/timerFake.js');

  const delay = (<T>(milliseconds?: number, value?: T, options?: { signal?: AbortSignal }) => {
    poll.started.resolve(undefined);

    return globalTimerDelay(milliseconds, value, options);
  }) as typeof original.setTimeout;

  return { ...original, setTimeout: delay };
});

vi.mock(import('../startFence/startFence.js'), { spy: true });

beforeEach(() => {
  poll.started = Promise.withResolvers<undefined>();
});

afterEach(() => {
  vi.useRealTimers();
});

it('releases the claim and rethrows the open error when the fence abandon fails', async ({
  onTestFinished: cleanup,
}) => {
  const { root, config } = await setup(cleanup);
  const { runtime } = openTool(root, undefined, undefined, { takeover: false });
  const abandonFailure = new Error('The start folder could not be read.');

  const child = useFakeStartProcess(cleanup, 'running');
  await recordSession(root);

  const actual = await vi.importActual<typeof StartFenceModule>('../startFence/startFence.js');

  vi.mocked(acquireStartFence).mockImplementationOnce(async (checkout, options, leadPid) => {
    const acquisition = await actual.acquireStartFence(checkout, options, leadPid);

    if (acquisition.kind !== 'acquired') {
      return acquisition;
    }

    const fence = {
      ...acquisition.fence,
      abandon: () => Promise.reject(abandonFailure),
    };

    return { kind: 'acquired', fence };
  });

  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  const opening = openArchitect(requestFor(root, config.location, runtime, 'Start ME-1611')).catch(
    (error: unknown) => error,
  );

  await poll.started.promise;

  child.state = 'gone';

  await vi.advanceTimersByTimeAsync(60_300);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(takeoverExpiryError().message);
  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
});
