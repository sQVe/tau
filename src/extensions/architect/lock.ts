import { join } from 'node:path';

import { withFileLock } from '../../fileLock/fileLock.js';
import { ensureTauDirectory } from '../../tauDirectory.js';

export const architectLockPath = (root: string): string => join(root, '.tau', 'architect', 'lock');

// Holds the checkout's architect lock until the returned release runs. A live holder aborts the
// wait and runs onRefused, so the caller can tell the user and shut down instead of queueing.
export const holdArchitectLock = async (
  root: string,
  onRefused: () => void,
): Promise<() => Promise<void>> => {
  const directory = await ensureTauDirectory(root, 'architect');
  const controller = new AbortController();
  const ready = Promise.withResolvers<() => Promise<void>>();

  const holding = withFileLock(
    {
      lockPath: join(directory, 'lock'),
      checkout: root,
      pollMilliseconds: 250,
      signal: controller.signal,
      cancelled: () => new Error('The architect is already running in another session.'),
      onWaiting: () => {
        controller.abort();
        onRefused();
      },
    },
    async () => {
      const released = Promise.withResolvers<undefined>();

      ready.resolve(async () => {
        released.resolve(undefined);
        await holding;
      });

      await released.promise;
    },
  );

  const settled = holding.then(
    () => ({ kind: 'ended' as const }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );

  const acquired = await Promise.race([
    ready.promise.then((release) => ({ kind: 'ready' as const, release })),
    settled,
  ]);

  if (acquired.kind === 'failed') {
    throw acquired.error;
  }

  if (acquired.kind === 'ended') {
    throw new Error('The architect lock ended before it was taken.');
  }

  return acquired.release;
};
