import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  detachedChildKeepsLockAfterParentExit,
  holderOutlivesKilledParent,
  holderPidPathFrom,
  lockFreesWhenEveryHolderIsGone,
  osLockConflictExitCode,
  osLockParentFixturePath,
  readOsLockState,
  runSpikeCommand,
  secondHolderRefused,
  startHolder,
  startParentWithHolder,
  supervisorWithoutFork,
  waitForHolderReady,
  waitForOsLockState,
  wrapperHoldsLockAcrossExec,
} from '../scripts/osLockSpike.js';
import { processState } from '../src/process/process.js';
import type { ProcessState } from '../src/process/process.js';

vi.setConfig({ testTimeout: 30_000 });

const processPollMilliseconds = 20;
const processTimeoutMilliseconds = 10_000;

const flockVersion = spawnSync('flock', ['-V'], { encoding: 'utf8' });

const flockAvailable =
  flockVersion.error === undefined &&
  flockVersion.status === 0 &&
  flockVersion.stdout.includes('util-linux');

const waitForProcessGone = async (processId: number): Promise<ProcessState> => {
  const deadline = Date.now() + processTimeoutMilliseconds;
  let state = processState(processId);

  while (state !== 'gone' && Date.now() < deadline) {
    await sleep(processPollMilliseconds);
    state = processState(processId);
  }

  return state;
};

const readHolderPid = async (path: string): Promise<number> => {
  const text = await readFile(path, 'utf8');
  const value = Number(text.trim());

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a process ID in ${path}, found ${JSON.stringify(text)}.`);
  }

  return value;
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
  expect(result.stderr).toContain('Usage: node osLockParentHarness.ts');
});

it('refuses to start a holder it has no process ID for', () => {
  const result = spawnSync(
    process.execPath,
    [
      osLockParentFixturePath,
      'wait',
      markerPath,
      holderPidPathFrom(markerPath),
      'tau-os-lock-program-that-does-not-exist',
    ],
    { encoding: 'utf8' },
  );

  expect(result.status).toBe(70);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('without a process ID');
});

it('refuses to start a holder it cannot record', () => {
  const result = spawnSync(
    process.execPath,
    [
      osLockParentFixturePath,
      'wait',
      markerPath,
      join(directory, 'missing', 'holder.pid'),
      'sleep',
      '60',
    ],
    { encoding: 'utf8' },
  );

  expect(result.status).toBe(70);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('could not be recorded');
});

it.skipIf(!flockAvailable)('stops a detached holder when the process ID read fails', async () => {
  await expect(startParentWithHolder('abandon', lockPath, markerPath)).rejects.toThrow(
    'exited before it printed its holder process ID',
  );

  const holderPid = await readHolderPid(holderPidPathFrom(markerPath));

  expect(await waitForProcessGone(holderPid)).toBe('gone');
  expect(await waitForOsLockState(lockPath, 'free')).toBe('free');
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
  const holder = startHolder(lockPath, heldMarker);

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

it.skipIf(!flockAvailable)('reports why a tracked holder exited before it was ready', async () => {
  const first = startHolder(lockPath, markerPath);

  try {
    await waitForHolderReady(markerPath, first);

    const secondMarker = join(directory, 'second.ready');
    const second = startHolder(lockPath, secondMarker);

    await expect(waitForHolderReady(secondMarker, second)).rejects.toThrow(
      'found the lock already held',
    );
  } finally {
    first.kill('SIGKILL');
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
