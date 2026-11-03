import { readdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, it, vi } from 'vitest';

import { withFileLock } from './fileLock.js';
import { cancelled, fixture, heldLocks } from './fixtures/fileLockHarness.js';

it('cancels a queued waiter without running it or changing the held lock', async () => {
  const { lockPath } = fixture();
  const held = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();

  const options = {
    lockPath,
    checkout: '/holder',
    signal: undefined,
    pollMilliseconds: 60_000,
    cancelled,
    onWaiting: () => undefined,
  };

  const holder = withFileLock(options, () => {
    held.resolve(undefined);

    return release.promise;
  });

  await held.promise;
  const original = await readFile(`${lockPath}.1`, 'utf8');
  const waiting = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const run = vi.fn<() => Promise<undefined>>(async () => undefined);

  const waiter = withFileLock(
    {
      ...options,
      signal: controller.signal,
      onWaiting: () => {
        waiting.resolve(undefined);
      },
    },
    run,
  );

  waiter.catch(() => undefined);

  try {
    await waiting.promise;
    controller.abort();
    await expect(waiter).rejects.toThrow('cancelled while it waited');

    expect(run).not.toHaveBeenCalled();
    expect(await readFile(`${lockPath}.1`, 'utf8')).toBe(original);
    expect(await heldLocks(lockPath)).toHaveLength(1);
    expect(await readdir(dirname(lockPath))).toHaveLength(1);
  } finally {
    controller.abort();
    release.resolve(undefined);
    await holder;
  }
});

it('releases a queued caller cancelled during acquisition without dispatching it', async () => {
  const { lockPath } = fixture();
  const held = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const waiting = Promise.withResolvers<undefined>();
  const controller = new AbortController();
  const run = vi.fn<() => Promise<string>>(async () => 'cancelled callback ran');
  let previousOwner: unknown;

  const options = {
    lockPath,
    checkout: '/holder',
    signal: undefined,
    pollMilliseconds: 10,
    cancelled,
    onWaiting: () => undefined,
  };

  const holder = withFileLock(options, () => {
    held.resolve(undefined);

    return release.promise;
  });

  await held.promise;

  const waiter = withFileLock(
    {
      ...options,
      checkout: '/waiter',
      signal: controller.signal,
      onWaiting: () => {
        waiting.resolve(undefined);
      },
      beforeLink: async () => {
        previousOwner = JSON.parse(await readFile(`${lockPath}.1`, 'utf8'));
        controller.abort();
      },
    },
    run,
  );

  waiter.catch(() => undefined);

  try {
    await waiting.promise;
    release.resolve(undefined);
    await holder;
    await expect(waiter).rejects.toThrow('cancelled while it waited');

    expect(run).not.toHaveBeenCalled();
    expect(previousOwner).toMatchObject({ checkout: '/holder', released: true });

    const cancelledOwner: unknown = JSON.parse(await readFile(`${lockPath}.2`, 'utf8'));

    expect(cancelledOwner).toMatchObject({ checkout: '/waiter', released: true });
    expect(await heldLocks(lockPath)).toEqual([]);

    const next = await withFileLock({ ...options, checkout: '/next' }, async () => 'ran');

    expect(next).toBe('ran');
    expect(await heldLocks(lockPath)).toEqual([]);
  } finally {
    controller.abort();
    release.resolve(undefined);
    await Promise.allSettled([holder, waiter]);
  }
});
