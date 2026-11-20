import { existsSync, mkdirSync, statSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { failedResult, succeededResult } from '../../../tests/execFake.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { holdFileLock } from '../../fileLock/fileLock.js';
import type { HcRuntime } from '../../hc/hc.js';
import { assignmentPath, writeAssignment } from './assignment.js';
import { savedAssignment } from './fixtures/deliveryManager.js';
import { sweepWorkerFolders } from './workerFolderSweep.js';

vi.mock(import('node:fs/promises'), { spy: true });

const hour = 3_600_000;
const minute = 60_000;

beforeEach(() => {
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const makeFolder = (root: string, name: string): string => {
  const folder = join(root, name);

  mkdirSync(folder, { recursive: true });

  return folder;
};

const setup = () => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-sweep-');

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  const hcFake = createHcFake();
  const details = new Map<string, string>();

  const gets = {
    started: [] as string[],
    hold: false,
    pending: [] as (() => void)[],
  };

  const exec: HcRuntime['exec'] = (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'get') {
      const address = commandArguments.at(-1) ?? '';
      const reply = details.get(address);
      const result = reply === undefined ? failedResult('not_found') : succeededResult(reply);

      gets.started.push(address);

      if (!gets.hold) {
        return Promise.resolve(result);
      }

      return new Promise((resolve) => {
        gets.pending.push(() => {
          resolve(result);
        });
      });
    }

    return hcFake.exec(command, commandArguments, options);
  };

  const hc: HcRuntime = { exec, connect: hcFake.connect, cwd: agentDirectory };
  const snapshotRoot = join(agentDirectory, 'tmp', 'tau-worker-packages');

  const listTerminals = (
    rows: { assignmentId: string; state: string; name?: string | null }[],
  ): void => {
    const terminals = rows.map(({ assignmentId, state, name }) => ({
      address: `t-${assignmentId}`,
      state,
      ...(name === undefined ? {} : { name }),
    }));

    hcFake.reply('ls', JSON.stringify({ terminals }));

    for (const row of rows) {
      details.set(
        `t-${row.assignmentId}`,
        JSON.stringify({
          address: `t-${row.assignmentId}`,
          state: row.state,
          labels: { 'tau.assignment': assignmentPath(row.assignmentId) },
        }),
      );
    }
  };

  return { agentDirectory, hc, gets, snapshotRoot, listTerminals };
};

const saveAssignmentWithSnapshot = async (
  agentDirectory: string,
  snapshotName: string | null,
): Promise<string> => {
  const assignment = savedAssignment(agentDirectory, null);

  assignment.packageSnapshot =
    snapshotName === null ? null : join(agentDirectory, 'tmp', 'tau-worker-packages', snapshotName);

  await writeAssignment(assignment);

  return assignment.assignmentId;
};

const sweepLockPath = (agentDirectory: string): string =>
  join(agentDirectory, '.tau-worker-folder-sweep.lock');

const unusedMarkerName = '.tau-unused-since';

const lockAttempts = (agentDirectory: string): number =>
  vi.mocked(fsPromises.readdir).mock.calls.filter(([path]) => path === agentDirectory).length;

const waitsForLock = (agentDirectory: string, baseline: number): Promise<'waiting' | 'timeout'> =>
  vi
    .waitFor(() => {
      expect(lockAttempts(agentDirectory)).toBeGreaterThan(baseline);
    })
    .then(() => 'waiting' as const)
    .catch(() => 'timeout' as const);

it('keeps a snapshot for a day after the follow-up that reused it ends', async () => {
  const { agentDirectory, hc, gets, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');
  const followUpId = await saveAssignmentWithSnapshot(agentDirectory, 'snapshot-source');
  const bystanderId = await saveAssignmentWithSnapshot(agentDirectory, null);
  const startedAt = Date.now();

  listTerminals([{ assignmentId: bystanderId, state: 'live' }]);
  gets.hold = true;

  const staleSweep = sweepWorkerFolders(hc, agentDirectory, () => startedAt, []);

  await vi.waitFor(() => {
    expect(gets.started).toHaveLength(1);
  });

  listTerminals([]);

  const baseline = lockAttempts(agentDirectory);

  const launchSweep = sweepWorkerFolders(hc, agentDirectory, () => startedAt, [
    {
      kind: 'read',
      assignmentId: followUpId,
      running: true,
      packageSnapshot: 'snapshot-source',
    },
  ]);

  // Base: the launch sweep finishes. Fixed: it waits for the first sweep's lock.
  await Promise.race([launchSweep, waitsForLock(agentDirectory, baseline)]);

  gets.hold = false;
  gets.pending.shift()?.();

  await staleSweep;
  await launchSweep;

  const endedAt = startedAt + 25 * hour;

  listTerminals([{ assignmentId: followUpId, state: 'finished' }]);

  await sweepWorkerFolders(hc, agentDirectory, () => endedAt, []);

  expect(existsSync(snapshot)).toBe(true);

  await sweepWorkerFolders(hc, agentDirectory, () => endedAt + 24 * hour, []);

  expect(existsSync(snapshot)).toBe(false);
});

it('starts the unused window after a sweep waits for the lock', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const marker = join(snapshot, unusedMarkerName);
  const startedAt = Date.now();
  let now = startedAt;

  listTerminals([]);

  const held = await holdFileLock({
    lockPath: sweepLockPath(agentDirectory),
    checkout: agentDirectory,
    terminal: undefined,
  });

  if (held.kind !== 'held') {
    throw new Error('Another session already holds the sweep lock.');
  }

  const baseline = lockAttempts(agentDirectory);
  const sweep = sweepWorkerFolders(hc, agentDirectory, () => now, []);

  await vi.waitFor(() => {
    expect(lockAttempts(agentDirectory)).toBeGreaterThan(baseline);
  });

  now = startedAt + 30 * minute;

  await held.release();

  await sweep;

  expect(statSync(marker).mtimeMs).toBeCloseTo(now, -1);
});
