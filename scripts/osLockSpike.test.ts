import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

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
  supervisorWithoutFork,
  wrapperHoldsLockAcrossExec,
} from './osLockSpike.js';

const flockAvailable = spawnSync('flock', ['-V'], { stdio: 'ignore' }).error === undefined;

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

it('wraps a command so the command itself holds the lock', () => {
  expect(
    osLockWrapperArgv('/checkout/.tau/architect/lock', ['env', 'TAU_ROLE=architect', 'pi']),
  ).toEqual([
    'flock',
    '-F',
    '-n',
    '-E',
    '75',
    '/checkout/.tau/architect/lock',
    'env',
    'TAU_ROLE=architect',
    'pi',
  ]);
});

it('wraps a holder so it signals readiness after the lock is taken', () => {
  expect(osLockHolderArgv('/checkout/.tau/architect/lock.ready', ['sleep', '60'])).toEqual([
    'sh',
    '-c',
    'printf ready > "$1" || exit 75; shift; exec "$@"',
    'tau-os-lock-holder',
    '/checkout/.tau/architect/lock.ready',
    'sleep',
    '60',
  ]);
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
