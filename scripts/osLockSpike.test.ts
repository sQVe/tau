import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  detachedChildKeepsLockAfterParentExit,
  holderOutlivesKilledParent,
  lockFreesWhenEveryHolderIsGone,
  osLockConflictExitCode,
  osLockWrapperArgv,
  readOsLockState,
  secondHolderRefused,
  supervisorWithoutFork,
  wrapperHoldsLockAcrossExec,
} from './osLockSpike.js';

let directory: string;
let lockPath: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tau-os-lock-spike-'));
  lockPath = join(directory, 'lock');
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

// flock parses this argv, so its shape is a protocol between Tau and the kernel helper.
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

it('reports a free lock and creates its file', async () => {
  expect(await readOsLockState(lockPath)).toBe('free');
  expect((await stat(lockPath)).isFile()).toBe(true);
});

it('refuses a second holder while the first is alive', async () => {
  expect(await secondHolderRefused(lockPath)).toBe(osLockConflictExitCode);
  expect(await readOsLockState(lockPath)).toBe('free');
});

it('keeps the lock when the holder outlives its killed parent', async () => {
  expect(await holderOutlivesKilledParent(lockPath)).toEqual({
    holderAlive: true,
    state: 'held',
  });
});

it('frees the lock once every holder is gone', async () => {
  expect(await lockFreesWhenEveryHolderIsGone(lockPath)).toEqual({
    before: 'held',
    after: 'free',
  });
});

it('keeps the lock in a detached child after its Node parent exits', async () => {
  expect(await detachedChildKeepsLockAfterParentExit(lockPath)).toEqual({
    parentExitCode: 0,
    state: 'held',
  });
});

it('holds the lock across the wrapper exec into its child', async () => {
  expect(await wrapperHoldsLockAcrossExec(lockPath)).toEqual({
    secondExitCode: osLockConflictExitCode,
    stateAfterKillingHolder: 'free',
  });
});

it('keeps the lock when a supervisor without the exec flag dies first', async () => {
  expect(await supervisorWithoutFork(lockPath)).toEqual({
    stateAfterSupervisorKilled: 'held',
    stateAfterGroupKilled: 'free',
  });
});
