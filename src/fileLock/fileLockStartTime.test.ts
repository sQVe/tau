import { readFile } from 'node:fs/promises';

import { afterEach, expect, it, vi } from 'vitest';

import { withFileLock } from './fileLock.js';
import { cancelled, fixture } from './fixtures/fileLockHarness.js';

const firstTime = new Date('2026-11-18T10:00:00.000Z');
const laterTime = new Date('2026-11-18T10:00:05.000Z');

afterEach(() => {
  vi.useRealTimers();
});

const startedAtOf = async (path: string): Promise<string> => {
  const owner = JSON.parse(await readFile(path, 'utf8')) as { startedAt: string };

  return owner.startedAt;
};

const lockAfterDelay = async (
  lockPath: string,
  run: (recordCommandGroup: (groupId: number) => Promise<void>) => Promise<void>,
): Promise<void> => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    now: firstTime,
  });

  await withFileLock(
    {
      lockPath,
      checkout: '/repo',
      signal: undefined,
      pollMilliseconds: 1,
      cancelled,
      onWaiting: () => undefined,
      beforeLink: () => {
        vi.setSystemTime(laterTime);

        return Promise.resolve();
      },
    },
    run,
  );
};

it('stamps the start time when the claim wins, not when the call began', async () => {
  const { lockPath } = fixture();
  let stamped = '';

  await lockAfterDelay(lockPath, async () => {
    stamped = await startedAtOf(`${lockPath}.1`);
  });

  expect(stamped).toBe(laterTime.toISOString());
});

it('keeps the winning start time when it records a command group', async () => {
  const { lockPath } = fixture();
  let stamped = '';
  let group: number | undefined;

  await lockAfterDelay(lockPath, async (recordCommandGroup) => {
    await recordCommandGroup(4242);
    stamped = await startedAtOf(`${lockPath}.1`);

    const owner = JSON.parse(await readFile(`${lockPath}.1`, 'utf8')) as { commandGroup: number };

    group = owner.commandGroup;
  });

  expect(stamped).toBe(laterTime.toISOString());
  expect(group).toBe(4242);
});
