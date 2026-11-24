import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  detachedChildKeepsLockAfterParentExit,
  holderOutlivesKilledParent,
  lockFreesWhenEveryHolderIsGone,
  osLockConflictExitCode,
  osLockHolderArgv,
  osLockParentFixturePath,
  osLockWrapperArgv,
  readOsLockState,
  runSpikeCommand,
  secondHolderRefused,
  startParentWithHolder,
  supervisorWithoutFork,
  waitForHolderReady,
  waitForOsLockState,
  wrapperHoldsLockAcrossExec,
} from '../scripts/osLockSpike.js';
import { processState } from '../src/process/process.js';

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

it('spawns the parent fixture from the resolved path', () => {
  const result = spawnSync(process.execPath, [osLockParentFixturePath], { encoding: 'utf8' });

  expect(result.status).toBe(64);
  expect(result.stderr).toContain('Usage: node osLockParent.ts');
});

it.skipIf(!flockAvailable)('stops the parent group when the process ID read fails', async () => {
  await expect(startParentWithHolder('abandon', lockPath, markerPath)).rejects.toThrow(
    'exited before it printed its holder process ID',
  );

  expect(await readOsLockState(lockPath)).toBe('free');
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

    expect(await readOsLockState(lockPath)).toBe('free');
  },
);

it.skipIf(!flockAvailable)('reports a held lock apart from a marker write failure', async () => {
  const heldMarker = join(directory, 'held.ready');
  const holder = spawnHolder(lockPath, heldMarker);

  try {
    await waitForHolderReady(heldMarker, holder);

    await expect(secondHolderRefused(lockPath, join(directory, 'conflict.ready'))).rejects.toThrow(
      'found the lock already held',
    );

    const { pid: holderPid } = holder;

    if (holderPid === undefined) {
      throw new Error('A spawned lock holder has a process ID.');
    }

    expect(processState(holderPid)).not.toBe('gone');
    expect(await readOsLockState(lockPath)).toBe('held');
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
