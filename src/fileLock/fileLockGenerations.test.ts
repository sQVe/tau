import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, it, vi } from 'vitest';

import { withFileLock } from './fileLock.js';
import { cancelled, fixture, heldLocks, ownerJson } from './fixtures/fileLockHarness.js';

it.each([
  { name: 'in the held lock file', replacement: undefined, recorded: { commandGroup: 4242 } },
  {
    name: 'only while the file is its own',
    replacement: ownerJson('other'),
    recorded: { token: 'other' },
  },
])('records the command group $name', async ({ replacement, recorded }) => {
  const { lockPath } = fixture();
  const heldPath = `${lockPath}.1`;

  const text = await withFileLock(
    {
      lockPath,
      checkout: '/holder',
      signal: undefined,
      pollMilliseconds: 60_000,
      cancelled,
      onWaiting: () => undefined,
    },
    async (recordCommandGroup) => {
      if (replacement !== undefined) {
        await writeFile(heldPath, replacement);
      }

      await recordCommandGroup(4242);

      return readFile(heldPath, 'utf8');
    },
  );

  expect(JSON.parse(text)).toMatchObject(recorded);
});

it('does not run while a higher generation is live after linking a lower one', async () => {
  const { lockPath } = fixture();
  const live = `${lockPath}.3`;

  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(`${lockPath}.1`, ownerJson('first', true));

  let stalled = false;
  let ranWhileLive = false;

  await withFileLock(
    {
      lockPath,
      checkout: '/stalled',
      signal: undefined,
      pollMilliseconds: 10,
      cancelled,
      onWaiting: () => {
        writeFile(live, ownerJson('third', true)).catch(() => undefined);
      },
      beforeLink: async () => {
        if (stalled) {
          return;
        }

        stalled = true;
        await writeFile(live, ownerJson('third'));
        await rm(`${lockPath}.1`);
      },
    },
    async () => {
      const text = await readFile(live, 'utf8').catch(() => undefined);

      // A removed file means the higher holder released and was replaced.
      ranWhileLive = text !== undefined && !text.includes('"released":true');
    },
  );

  expect(ranWhileLive).toBe(false);
  expect(await heldLocks(lockPath)).toEqual([]);
});

it('retries when another caller links the same first generation', async () => {
  const { lockPath } = fixture();
  const bothArrived = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const contended = Promise.withResolvers<undefined>();
  let arrived = 0;
  let active = 0;
  let maxActive = 0;
  let maxHeld = 0;
  let waitingCount = 0;

  const options = {
    lockPath,
    checkout: '/racer',
    signal: undefined,
    pollMilliseconds: 10,
    cancelled,
    onWaiting: () => {
      waitingCount += 1;
      contended.resolve(undefined);
    },
    beforeLink: async () => {
      arrived += 1;

      if (arrived === 2) {
        bothArrived.resolve(undefined);
      }

      await release.promise;
    },
  };

  const run = vi.fn<() => Promise<string>>(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);

    if (active > 1) {
      contended.resolve(undefined);
    }

    const held = await heldLocks(lockPath);
    maxHeld = Math.max(maxHeld, held.length);

    await contended.promise;
    active -= 1;

    return 'ran';
  });

  const first = withFileLock(options, run);
  const second = withFileLock({ ...options, checkout: '/other-racer' }, run);
  const outcomes = Promise.all([first, second]);

  outcomes.catch(() => {
    contended.resolve(undefined);
  });

  await bothArrived.promise;
  release.resolve(undefined);

  expect(await outcomes).toEqual(['ran', 'ran']);
  expect(run).toHaveBeenCalledTimes(2);
  expect(maxActive).toBe(1);
  expect(maxHeld).toBe(1);
  expect(waitingCount).toBeGreaterThan(0);
  expect(await heldLocks(lockPath)).toEqual([]);
});
