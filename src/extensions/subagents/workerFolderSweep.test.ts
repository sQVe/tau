import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { failedResult, succeededResult } from '../../../tests/execFake.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime } from '../../hc/hc.js';
import { assignmentPath, writeAssignment } from './assignment.js';
import { savedAssignment } from './fixtures/deliveryManager.js';
import type { StartingWorker } from './workerFolderDecision.js';
import { sweepWorkerFolders } from './workerFolderSweep.js';
import type { WorkerFolderSweep } from './workerFolderSweep.js';
import { scratchRootFor } from './workerScratch.js';

vi.mock(import('node:fs/promises'), { spy: true });

const minute = 60_000;
const hour = 3_600_000;

const sweepAt = (
  hc: HcRuntime,
  agentDirectory: string,
  now: number,
  starting: readonly StartingWorker[],
): Promise<WorkerFolderSweep> => sweepWorkerFolders(hc, agentDirectory, () => now, starting);

beforeEach(() => {
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(fsPromises.stat).mockRestore();
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
    timeouts: [] as (number | undefined)[],
    timedOut: new Set<string>(),
    active: 0,
    peak: 0,
    hold: false,
    pending: [] as (() => void)[],
  };

  // Real hc lists terminals without labels. Only `hc get` returns them.
  const exec: HcRuntime['exec'] = (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'get') {
      const address = commandArguments.at(-1) ?? '';
      const reply = details.get(address);

      const found = reply === undefined ? failedResult('not_found') : succeededResult(reply);

      const result = gets.timedOut.has(address)
        ? { ...failedResult('', 143), killed: true }
        : found;

      gets.started.push(address);
      gets.timeouts.push(options?.timeout);
      gets.active += 1;
      gets.peak = Math.max(gets.peak, gets.active);

      const settle = () => {
        gets.active -= 1;

        return result;
      };

      if (!gets.hold) {
        return Promise.resolve(settle());
      }

      return new Promise((resolve) => {
        gets.pending.push(() => {
          resolve(settle());
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

  return {
    agentDirectory,
    hcFake,
    hc,
    details,
    gets,
    snapshotRoot,
    scratchRoot: scratchRootFor(agentDirectory),
    listTerminals,
  };
};

const bornAt = (folder: string): number => {
  const stats = statSync(folder);

  return stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
};

const unusedMarkerName = '.tau-unused-since';

const writeUnusedMarker = (snapshot: string, at: number): void => {
  const path = join(snapshot, unusedMarkerName);

  writeFileSync(path, '');
  utimesSync(path, at / 1000, at / 1000);
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

it('removes the scratch folder of a finished worker', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');

  listTerminals([{ assignmentId: 'assignment-a', state: 'finished' }]);

  const result = await sweepAt(hc, agentDirectory, bornAt(folder) + 2 * minute, []);

  expect(existsSync(folder)).toBe(false);
  expect(result).toEqual({ removed: [folder], errors: [] });
});

it('removes the scratch folder of a worker hc no longer lists', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');

  listTerminals([]);

  await sweepAt(hc, agentDirectory, bornAt(folder) + 2 * minute, []);

  expect(existsSync(folder)).toBe(false);
});

it('keeps the scratch folder of a running worker', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, null);
  const folder = makeFolder(scratchRoot, runningId);

  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  const result = await sweepAt(hc, agentDirectory, bornAt(folder) + 2 * minute, []);

  expect(existsSync(folder)).toBe(true);
  expect(result).toEqual({ removed: [], errors: [] });
});

it('reports a failed hc list', async () => {
  const { agentDirectory, hcFake, hc, scratchRoot, snapshotRoot } = setup();
  const scratch = makeFolder(scratchRoot, 'assignment-a');
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  hcFake.fail('ls', 'boom', 1);

  const now = Math.max(bornAt(scratch), bornAt(snapshot)) + 25 * hour;
  const result = await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(scratch)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
  expect(result.removed).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('Listing hc terminals failed');
});

it("keeps every snapshot when a running worker's assignment file is missing", async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  listTerminals([{ assignmentId: 'assignment-without-file', state: 'live' }]);

  await sweepAt(hc, agentDirectory, bornAt(snapshot) + 25 * hour, []);

  expect(existsSync(snapshot)).toBe(true);
});

it("keeps every snapshot when a running worker's assignment file is malformed", async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const path = assignmentPath('assignment-malformed');

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ not json');

  listTerminals([{ assignmentId: 'assignment-malformed', state: 'live' }]);

  await sweepAt(hc, agentDirectory, bornAt(snapshot) + 25 * hour, []);

  expect(existsSync(snapshot)).toBe(true);
});

it('removes a snapshot unused for a day and keeps the one a running worker names', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const unused = makeFolder(snapshotRoot, 'snapshot-unused');
  const used = makeFolder(snapshotRoot, 'snapshot-used');
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, 'snapshot-used');
  const now = Date.now();

  writeUnusedMarker(unused, now - 25 * hour);
  writeUnusedMarker(used, now - 25 * hour);
  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  const result = await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(unused)).toBe(false);
  expect(existsSync(used)).toBe(true);
  expect(result).toEqual({ removed: [unused], errors: [] });
});

it('keeps the old snapshot a starting follow-up reuses', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');

  listTerminals([]);

  await sweepAt(hc, agentDirectory, bornAt(snapshot) + 25 * hour, [
    {
      kind: 'read',
      assignmentId: 'follow-up',
      running: true,
      packageSnapshot: 'snapshot-source',
      terminalAddress: 't-follow-up',
    },
  ]);

  expect(existsSync(snapshot)).toBe(true);
});

it('keeps the marker when a detail read shows the starting worker finished', async () => {
  const { agentDirectory, details, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');
  const marker = join(snapshot, unusedMarkerName);
  const now = Date.now();
  const id = 'follow-up';

  writeUnusedMarker(snapshot, now - hour);
  listTerminals([{ assignmentId: id, state: 'live', name: 'worker-0123abcd' }]);

  details.set(
    `t-${id}`,
    JSON.stringify({
      address: `t-${id}`,
      state: 'finished',
      labels: { 'tau.assignment': assignmentPath(id) },
    }),
  );

  await sweepAt(hc, agentDirectory, now, [
    {
      kind: 'read',
      assignmentId: id,
      running: true,
      packageSnapshot: 'snapshot-source',
      terminalAddress: `t-${id}`,
    },
  ]);

  expect(existsSync(marker)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
});

it('keeps the starting hint when only another terminal finished', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');
  const marker = join(snapshot, unusedMarkerName);
  const now = Date.now();

  writeUnusedMarker(snapshot, now - hour);
  listTerminals([{ assignmentId: 'other', state: 'finished' }]);

  await sweepAt(hc, agentDirectory, now, [
    {
      kind: 'read',
      assignmentId: 'follow-up',
      running: true,
      packageSnapshot: 'snapshot-source',
      terminalAddress: 't-follow-up',
    },
  ]);

  expect(existsSync(marker)).toBe(false);
  expect(existsSync(snapshot)).toBe(true);
});

it('keeps the snapshot a live worker names when the starting hint finished', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-used');
  const marker = join(snapshot, unusedMarkerName);
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, 'snapshot-used');
  const now = Date.now();

  writeUnusedMarker(snapshot, now - hour);

  listTerminals([
    { assignmentId: runningId, state: 'live' },
    { assignmentId: 'follow-up', state: 'finished' },
  ]);

  await sweepAt(hc, agentDirectory, now, [
    {
      kind: 'read',
      assignmentId: 'follow-up',
      running: true,
      packageSnapshot: 'snapshot-used',
      terminalAddress: 't-follow-up',
    },
  ]);

  expect(existsSync(marker)).toBe(false);
  expect(existsSync(snapshot)).toBe(true);
});

it('keeps a snapshot unused for just under a day', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');
  const now = Date.now();

  writeUnusedMarker(snapshot, now - 24 * hour + 1000);
  listTerminals([]);

  await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(snapshot)).toBe(true);
});

it('keeps the scratch folder of a starting launch', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-starting');

  listTerminals([]);

  await sweepAt(hc, agentDirectory, bornAt(folder) + 2 * minute, [
    {
      kind: 'read',
      assignmentId: 'assignment-starting',
      running: true,
      packageSnapshot: null,
      terminalAddress: 't-assignment-starting',
    },
  ]);

  expect(existsSync(folder)).toBe(true);
});

it('ignores files in the folder roots and a missing root', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();

  makeFolder(scratchRoot, 'assignment-a');
  writeFileSync(join(scratchRoot, 'stray-file'), 'x');

  listTerminals([]);

  const result = await sweepAt(hc, agentDirectory, Date.now() + 2 * minute, []);

  expect(existsSync(join(scratchRoot, 'stray-file'))).toBe(true);
  expect(result.removed).toEqual([join(scratchRoot, 'assignment-a')]);
  expect(result.errors).toEqual([]);
});

it('reports a removal error and keeps the redirected folder', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const elsewhere = temporaryDirectory(onTestFinished, 'tau-sweep-redirect-');
  const target = makeFolder(elsewhere, 'assignment-a');

  mkdirSync(dirname(scratchRoot), { recursive: true });
  symlinkSync(elsewhere, scratchRoot);

  listTerminals([]);

  const result = await sweepAt(hc, agentDirectory, bornAt(target) + 2 * minute, []);

  expect(existsSync(target)).toBe(true);
  expect(result.removed).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('redirected');
});

const actualFsPromises = await vi.importActual<typeof fsPromises>('node:fs/promises');

const replaceStat = (path: string, reply: () => Promise<unknown>): void => {
  vi.mocked(fsPromises.stat).mockImplementation(((target: string, ...rest: never[]) =>
    target === path ? reply() : actualFsPromises.stat(target, ...rest)) as typeof fsPromises.stat);
};

const failure = (message: string, code: string): Promise<never> =>
  Promise.reject(Object.assign(new Error(message), { code }));

it('dates a folder by its birth time when the file system reports one', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');
  const now = bornAt(folder) + 2 * minute;

  replaceStat(folder, () =>
    Promise.resolve({ birthtimeMs: now - 2 * minute, mtimeMs: now + 10 * hour }),
  );

  listTerminals([]);

  await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(folder)).toBe(false);
});

it('dates a folder by its modification time when the birth time is 0', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');
  const now = bornAt(folder) + 2 * minute;

  replaceStat(folder, () => Promise.resolve({ birthtimeMs: 0, mtimeMs: now - 30_000 }));
  listTerminals([]);

  await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(folder)).toBe(true);
});

it('skips a folder that vanishes while the sweep reads it', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const vanishing = makeFolder(scratchRoot, 'assignment-vanishing');
  const staying = makeFolder(scratchRoot, 'assignment-staying');
  replaceStat(vanishing, () => failure('gone', 'ENOENT'));

  listTerminals([]);

  const result = await sweepAt(hc, agentDirectory, bornAt(staying) + 2 * minute, []);

  expect(existsSync(staying)).toBe(false);
  expect(result).toEqual({ removed: [staying], errors: [] });
});

it('fails the sweep when a folder cannot be read for another reason', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');
  replaceStat(folder, () => failure('denied', 'EACCES'));

  listTerminals([]);

  await expect(sweepAt(hc, agentDirectory, Date.now(), [])).rejects.toThrow('denied');
  expect(existsSync(folder)).toBe(true);
});

it('ignores terminals without a tau.assignment label', async () => {
  const { agentDirectory, hcFake, hc, details, scratchRoot, snapshotRoot } = setup();
  const scratch = makeFolder(scratchRoot, 'assignment-a');
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const addresses = ['t-bare', 't-other', 't-empty'];

  hcFake.reply(
    'ls',
    JSON.stringify({ terminals: addresses.map((address) => ({ address, state: 'live' })) }),
  );

  details.set('t-bare', JSON.stringify({ address: 't-bare', state: 'live' }));

  details.set(
    't-other',
    JSON.stringify({ address: 't-other', state: 'live', labels: { 'tau.role': 'worker' } }),
  );

  details.set(
    't-empty',
    JSON.stringify({ address: 't-empty', state: 'live', labels: { 'tau.assignment': '' } }),
  );

  const now = Math.max(bornAt(scratch), bornAt(snapshot)) + 25 * hour;

  writeUnusedMarker(snapshot, now - 25 * hour);

  const result = await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(scratch)).toBe(false);
  expect(existsSync(snapshot)).toBe(false);
  expect(result.errors).toEqual([]);
});

it('does not let a running worker without a snapshot protect snapshots', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, null);

  const now = Date.now();

  writeUnusedMarker(snapshot, now - 25 * hour);
  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(snapshot)).toBe(false);
});

it('does not read the assignment of a finished worker for its snapshot', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  const now = Date.now();

  writeUnusedMarker(snapshot, now - 25 * hour);
  listTerminals([{ assignmentId: 'assignment-without-file', state: 'finished' }]);

  await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(snapshot)).toBe(false);
});

it('keeps the scratch folder and snapshot of a running worker that hc ls lists without labels', async () => {
  const { agentDirectory, hc, scratchRoot, snapshotRoot, listTerminals } = setup();
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, 'snapshot-used');
  const scratch = makeFolder(scratchRoot, runningId);
  const snapshot = makeFolder(snapshotRoot, 'snapshot-used');

  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  const now = Math.max(bornAt(scratch), bornAt(snapshot)) + 25 * hour;

  await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(scratch)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
});

it('keeps a scratch folder no terminal names inside the launch grace', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');

  listTerminals([]);

  await sweepAt(hc, agentDirectory, bornAt(folder) + 5_000, []);

  expect(existsSync(folder)).toBe(true);
});

const readFailures: { name: string; arrange: (state: ReturnType<typeof setup>) => void }[] = [
  {
    name: 'the hc list is not JSON',
    arrange: ({ hcFake }) => {
      hcFake.reply('ls', 'not json');
    },
  },
  {
    name: 'the hc list has no terminals array',
    arrange: ({ hcFake }) => {
      hcFake.reply('ls', JSON.stringify({ terminals: 'none' }));
    },
  },
];

it.each(readFailures)('removes nothing when $name', async ({ arrange }) => {
  const state = setup();
  const scratch = makeFolder(state.scratchRoot, 'assignment-a');
  const snapshot = makeFolder(state.snapshotRoot, 'snapshot-a');

  arrange(state);

  const now = Math.max(bornAt(scratch), bornAt(snapshot)) + 25 * hour;
  const result = await sweepAt(state.hc, state.agentDirectory, now, []);

  expect(existsSync(scratch)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
  expect(result.removed).toEqual([]);
  expect(result.errors).toHaveLength(1);
});

const nextMacrotask = (): Promise<undefined> => {
  const { promise, resolve } = Promise.withResolvers<undefined>();

  setImmediate(() => {
    resolve(undefined);
  });

  return promise;
};

const idA = '0123abcd-1111-2222-3333-444455556666';
const idB = 'fedcba98-1111-2222-3333-444455556666';

it("keeps only the failed terminal's scratch folder", async () => {
  const { agentDirectory, hc, details, scratchRoot, snapshotRoot, listTerminals } = setup();
  const folderA = makeFolder(scratchRoot, idA);
  const folderB = makeFolder(scratchRoot, idB);
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  listTerminals([{ assignmentId: idA, state: 'live', name: 'worker-0123abcd' }]);
  details.delete(`t-${idA}`);

  const now = Math.max(bornAt(folderA), bornAt(folderB), bornAt(snapshot)) + 25 * hour;
  const result = await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(folderA)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
  expect(existsSync(folderB)).toBe(false);
  expect(result.removed).toEqual([folderB]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain(`Reading terminal t-${idA} failed`);
  expect(result.errors[0]).toContain('Kept its folders.');
});

it('keeps the failed terminal folders when hc get returns malformed output', async () => {
  const { agentDirectory, hc, details, scratchRoot, listTerminals } = setup();
  const folderA = makeFolder(scratchRoot, idA);
  const folderB = makeFolder(scratchRoot, idB);

  listTerminals([{ assignmentId: idA, state: 'live', name: 'worker-0123abcd' }]);
  details.set(`t-${idA}`, 'not json');

  const result = await sweepAt(hc, agentDirectory, bornAt(folderA) + 2 * minute, []);

  expect(existsSync(folderA)).toBe(true);
  expect(existsSync(folderB)).toBe(false);
  expect(result.errors).toHaveLength(1);
});

it('keeps every folder when a failed terminal has no worker name', async () => {
  const { agentDirectory, hc, details, scratchRoot, snapshotRoot, listTerminals } = setup();
  const folderA = makeFolder(scratchRoot, idA);
  const folderB = makeFolder(scratchRoot, idB);
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  listTerminals([{ assignmentId: idA, state: 'live' }]);
  details.delete(`t-${idA}`);

  const now = Math.max(bornAt(folderA), bornAt(folderB), bornAt(snapshot)) + 25 * hour;
  const result = await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(folderA)).toBe(true);
  expect(existsSync(folderB)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
  expect(result.removed).toEqual([]);
  expect(result.errors).toHaveLength(1);
});

it('reads no finished terminal', async () => {
  const { agentDirectory, hc, gets, scratchRoot, listTerminals } = setup();
  const ids = ['assignment-a', 'assignment-b', 'assignment-c'];
  const folders = ids.map((id) => makeFolder(scratchRoot, id));

  listTerminals(ids.map((assignmentId) => ({ assignmentId, state: 'finished' })));

  const result = await sweepAt(hc, agentDirectory, bornAt(folders[0] ?? '') + 2 * minute, []);

  expect(gets.started).toEqual([]);
  expect(result.removed.toSorted()).toEqual(folders.toSorted());
  expect(result.errors).toEqual([]);
});

it('skips live terminals that are not workers', async () => {
  const { agentDirectory, hc, gets, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');

  listTerminals([
    { assignmentId: 'assignment-shell', state: 'live', name: 'shell' },
    { assignmentId: 'assignment-short', state: 'live', name: 'worker-0123ABCD' },
  ]);

  await sweepAt(hc, agentDirectory, bornAt(folder) + 2 * minute, []);

  expect(gets.started).toEqual([]);
  expect(existsSync(folder)).toBe(false);
});

it('runs at most four terminal reads at once', async () => {
  const { agentDirectory, hc, gets, listTerminals } = setup();

  const rows = Array.from({ length: 10 }, (_, index) => ({
    assignmentId: `0000000${index}-aaaa`,
    state: 'live',
    name: `worker-0000000${index}`,
  }));

  gets.hold = true;
  listTerminals(rows);

  const sweep = sweepAt(hc, agentDirectory, Date.now(), []);

  await vi.waitFor(() => {
    expect(gets.started).toHaveLength(4);
  });

  await nextMacrotask();
  expect(gets.started).toHaveLength(4);

  gets.pending.shift()?.();

  await vi.waitFor(() => {
    expect(gets.started).toHaveLength(5);
  });

  while (gets.started.length < rows.length || gets.pending.length > 0) {
    gets.pending.shift()?.();
    await nextMacrotask();
  }

  await sweep;

  expect(gets.started).toHaveLength(10);
  expect(gets.peak).toBe(4);
});

it('writes the unused marker and removes the snapshot a day later', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const marker = join(snapshot, unusedMarkerName);
  const firstSweep = Date.now() + 30 * hour;

  listTerminals([]);

  const first = await sweepAt(hc, agentDirectory, firstSweep, []);

  expect(existsSync(snapshot)).toBe(true);
  expect(statSync(marker).mtimeMs).toBeCloseTo(firstSweep, -1);
  expect(first).toEqual({ removed: [], errors: [] });

  const markedAt = statSync(marker).mtimeMs;

  await sweepAt(hc, agentDirectory, markedAt + 24 * hour - 1000, []);

  expect(existsSync(snapshot)).toBe(true);

  const second = await sweepAt(hc, agentDirectory, markedAt + 24 * hour, []);

  expect(existsSync(snapshot)).toBe(false);
  expect(second).toEqual({ removed: [snapshot], errors: [] });
});

it('clears the marker when a running worker names the snapshot', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-used');
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, 'snapshot-used');
  const now = Date.now();

  writeUnusedMarker(snapshot, now - 25 * hour);
  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  const result = await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(snapshot)).toBe(true);
  expect(readdirSync(snapshot)).toEqual([]);
  expect(result).toEqual({ removed: [], errors: [] });
});

it('reports a marker that cannot be written and still removes the other folders', async () => {
  const { agentDirectory, hc, scratchRoot, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const scratch = makeFolder(scratchRoot, 'assignment-a');

  vi.mocked(fsPromises.open).mockRejectedValueOnce(new Error('disk full'));

  onTestFinished(() => {
    vi.mocked(fsPromises.open).mockRestore();
  });

  listTerminals([]);

  const result = await sweepAt(hc, agentDirectory, bornAt(scratch) + 2 * minute, []);

  expect(existsSync(scratch)).toBe(false);
  expect(result.removed).toEqual([scratch]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('snapshot-a');
  expect(result.errors[0]).toContain('disk full');
  expect(existsSync(join(snapshot, unusedMarkerName))).toBe(false);
});

it('passes a 10 s limit to each hc get', async () => {
  const { agentDirectory, hc, gets, listTerminals } = setup();

  listTerminals([
    { assignmentId: 'assignment-a', state: 'live' },
    { assignmentId: 'assignment-b', state: 'live' },
  ]);

  await sweepAt(hc, agentDirectory, Date.now(), []);

  expect(gets.timeouts).toEqual([10_000, 10_000]);
});

it('keeps folders and reports a timed-out read', async () => {
  const { agentDirectory, hc, gets, scratchRoot, snapshotRoot, listTerminals } = setup();
  const folderA = makeFolder(scratchRoot, idA);
  const folderB = makeFolder(scratchRoot, idB);
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  listTerminals([{ assignmentId: idA, state: 'live', name: 'worker-0123abcd' }]);
  gets.timedOut.add(`t-${idA}`);

  const now = Math.max(bornAt(folderA), bornAt(folderB), bornAt(snapshot)) + 25 * hour;

  writeUnusedMarker(snapshot, now - 25 * hour);

  const result = await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(folderA)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
  expect(existsSync(folderB)).toBe(false);
  expect(result.removed).toEqual([folderB]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain(`Reading terminal t-${idA} failed`);
});

it('clears the marker of the starting snapshot when hc ls fails and removes nothing', async () => {
  const { agentDirectory, hcFake, hc, scratchRoot, snapshotRoot } = setup();
  const reused = makeFolder(snapshotRoot, 'snapshot-reused');
  const other = makeFolder(snapshotRoot, 'snapshot-other');
  const scratch = makeFolder(scratchRoot, 'assignment-a');
  const now = Date.now();

  writeUnusedMarker(reused, now - 25 * hour);
  writeUnusedMarker(other, now - 25 * hour);
  hcFake.fail('ls', 'boom', 1);

  const result = await sweepAt(hc, agentDirectory, now, [
    {
      kind: 'read',
      assignmentId: 'follow-up',
      running: true,
      packageSnapshot: 'snapshot-reused',
      terminalAddress: 't-follow-up',
    },
  ]);

  expect(existsSync(join(reused, unusedMarkerName))).toBe(false);
  expect(existsSync(join(other, unusedMarkerName))).toBe(true);
  expect(existsSync(reused)).toBe(true);
  expect(existsSync(other)).toBe(true);
  expect(existsSync(scratch)).toBe(true);
  expect(result.removed).toEqual([]);
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('Listing hc terminals failed');
});

it('writes no marker when hc ls fails', async () => {
  const { agentDirectory, hcFake, hc, snapshotRoot } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  hcFake.fail('ls', 'boom', 1);

  await sweepAt(hc, agentDirectory, Date.now(), []);

  expect(existsSync(join(snapshot, unusedMarkerName))).toBe(false);
});

it('refuses a redirected snapshot root for marker changes', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const elsewhere = temporaryDirectory(onTestFinished, 'tau-sweep-redirect-');
  const unnamed = makeFolder(elsewhere, 'snapshot-unnamed');
  const named = makeFolder(elsewhere, 'snapshot-used');
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, 'snapshot-used');
  const now = Date.now();

  writeUnusedMarker(named, now - 25 * hour);
  mkdirSync(dirname(snapshotRoot), { recursive: true });
  symlinkSync(elsewhere, snapshotRoot);
  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  const result = await sweepAt(hc, agentDirectory, now, []);

  expect(existsSync(join(unnamed, unusedMarkerName))).toBe(false);
  expect(existsSync(join(named, unusedMarkerName))).toBe(true);
  expect(result.removed).toEqual([]);
  expect(result.errors).toHaveLength(2);
  expect(result.errors.every((error) => error.includes('redirected'))).toBe(true);
});
