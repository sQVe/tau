import { afterEach, expect, it, vi } from 'vitest';

import { readLiveLockHolder } from '../../../fileLock/fileLock.js';
import { appCommands, open, openRequest, openTool } from '../fixtures/openHarness.js';
import { setup } from '../fixtures/toolHarness.js';
import { architectLockPath } from '../lock.js';

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

afterEach(() => {
  vi.useRealTimers();
});

it('throws and leaves no live claim when no architect takes the lock in 60 seconds', async ({
  onTestFinished: cleanup,
}) => {
  const { root } = await setup(cleanup);
  const { app, tool } = openTool(root, undefined, undefined, { takeover: false });

  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });

  const opening = open(tool, root, { request: openRequest }).catch((error: unknown) => error);

  await poll.started.promise;
  await vi.advanceTimersByTimeAsync(60_000);

  const failure = await opening;

  expect(failure).toBeInstanceOf(Error);

  expect((failure as Error).message).toBe(
    'The architect did not take the checkout lock within 60 seconds. Call architect open again.',
  );

  expect(await readLiveLockHolder(architectLockPath(root))).toBeUndefined();
  expect(appCommands(app)).toContain('pane.split');
});
