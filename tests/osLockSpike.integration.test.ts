import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  detachedChildKeepsLockAfterParentExit,
  holderOutlivesKilledParent,
  lockFreesWhenEveryHolderIsGone,
  osLockConflictExitCode,
  osLockHolderArgv,
  osLockParentFixturePath,
  osLockParentFixturePathFrom,
  osLockWrapperArgv,
  readOsLockState,
  runSpikeCommand,
  secondHolderRefused,
  supervisorWithoutFork,
  waitForOsLockState,
  wrapperHoldsLockAcrossExec,
} from '../scripts/osLockSpike.js';

vi.setConfig({ testTimeout: 30_000 });

const flockVersion = spawnSync('flock', ['-V'], { encoding: 'utf8' });

const flockAvailable =
  flockVersion.error === undefined &&
  flockVersion.status === 0 &&
  flockVersion.stdout.includes('util-linux');

const spawnHolder = (lockPath: string, markerPath: string): ChildProcess => {
  const [command, ...commandArguments] = osLockWrapperArgv(
    lockPath,
    osLockHolderArgv(markerPath, ['sleep', '60']),
  );

  if (command === undefined) {
    throw new Error('A holder needs a program to run.');
  }

  return spawn(command, commandArguments, { stdio: 'ignore' });
};

let directory: string;
let lockPath: string;
let markerPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tau-os-lock-spike-'));
  lockPath = join(directory, 'lock');
  markerPath = join(directory, 'ready');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('rejects a command that cannot start', async () => {
  await expect(runSpikeCommand(['tau-os-lock-program-that-does-not-exist'])).rejects.toThrow(
    'ENOENT',
  );
});

it('refuses to run the parent fixture without a marker and a command', () => {
  const result = spawnSync(process.execPath, [osLockParentFixturePath], { encoding: 'utf8' });

  expect(result.status).toBe(64);
  expect(result.stderr).toContain('Usage: node osLockParent.ts');
});

it('spawns the parent fixture from a checkout path with a space', async () => {
  const scriptDirectory = join(directory, 'checkout with space', 'scripts');

  const fixturePath = osLockParentFixturePathFrom(
    pathToFileURL(join(scriptDirectory, 'osLockSpike.ts')),
  );

  await mkdir(join(scriptDirectory, 'fixtures'), { recursive: true });
  await copyFile(osLockParentFixturePath, fixturePath);

  const result = spawnSync(process.execPath, [fixturePath], { encoding: 'utf8' });

  expect(result.status).toBe(64);
  expect(result.stderr).toContain('Usage: node osLockParent.ts');
});

it.skipIf(!flockAvailable)('reports a free lock and creates its file', async () => {
  expect(await readOsLockState(lockPath)).toBe('free');
  expect((await stat(lockPath)).isFile()).toBe(true);
});

it.skipIf(!flockAvailable)('rejects a lock path that flock cannot open', async () => {
  await expect(readOsLockState(join(directory, 'missing', 'lock'))).rejects.toThrow('exited 66');
});

it.skipIf(!flockAvailable)('refuses a second holder while the first is alive', async () => {
  expect(await secondHolderRefused(lockPath, markerPath)).toBe(osLockConflictExitCode);
  expect(await readOsLockState(lockPath)).toBe('free');
});

it.skipIf(!flockAvailable)(
  'reports a marker write failure apart from a lock conflict',
  async () => {
    const missingMarker = join(directory, 'missing', 'ready');

    await expect(secondHolderRefused(lockPath, missingMarker)).rejects.toThrow(
      'could not write its readiness marker',
    );
  },
);

it.skipIf(!flockAvailable)('reports a held lock apart from a marker write failure', async () => {
  const holder = spawnHolder(lockPath, join(directory, 'held.ready'));

  try {
    await waitForOsLockState(lockPath, 'held');

    await expect(secondHolderRefused(lockPath, join(directory, 'conflict.ready'))).rejects.toThrow(
      'found the lock already held',
    );
  } finally {
    holder.kill('SIGKILL');
    await waitForOsLockState(lockPath, 'free');
  }
});

it.skipIf(!flockAvailable)(
  'keeps the lock when the holder outlives its killed parent',
  async () => {
    expect(await holderOutlivesKilledParent(lockPath, markerPath)).toEqual({
      holderAlive: true,
      state: 'held',
    });
  },
);

it.skipIf(!flockAvailable)('frees the lock once every holder is gone', async () => {
  expect(await lockFreesWhenEveryHolderIsGone(lockPath, markerPath)).toEqual({
    before: 'held',
    after: 'free',
  });
});

it.skipIf(!flockAvailable)(
  'keeps the lock in a detached child after its Node parent exits',
  async () => {
    expect(await detachedChildKeepsLockAfterParentExit(lockPath, markerPath)).toEqual({
      parentExitCode: 0,
      stateBeforeParentExit: 'held',
      state: 'held',
    });
  },
);

it.skipIf(!flockAvailable)('holds the lock across the wrapper exec into its child', async () => {
  expect(await wrapperHoldsLockAcrossExec(lockPath, markerPath)).toEqual({
    secondExitCode: osLockConflictExitCode,
    stateAfterKillingHolder: 'free',
  });
});

it.skipIf(!flockAvailable)(
  'keeps the lock when a supervisor without the exec flag dies first',
  async () => {
    expect(await supervisorWithoutFork(lockPath, markerPath)).toEqual({
      stateAfterSupervisorKilled: 'held',
      stateAfterGroupKilled: 'free',
    });
  },
);
