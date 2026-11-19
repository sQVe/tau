import { existsSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { failedResult, succeededResult } from '../../../tests/execFake.js';
import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { HcRuntime } from '../../hc/hc.js';
import { assignmentPath, writeAssignment } from './assignment.js';
import { savedAssignment } from './fixtures/deliveryManager.js';
import { sweepWorkerFolders } from './workerFolderSweep.js';
import { scratchRootFor } from './workerScratch.js';

vi.mock(import('node:fs/promises'), { spy: true });

const minute = 60_000;
const hour = 3_600_000;

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

  // Real hc lists terminals without labels. Only `hc get` returns them.
  const exec: HcRuntime['exec'] = (command, commandArguments, options) => {
    if (command === 'hc' && commandArguments[0] === 'get') {
      const reply = details.get(commandArguments.at(-1) ?? '');

      const result = reply === undefined ? failedResult('not_found') : succeededResult(reply);

      return Promise.resolve(result);
    }

    return hcFake.exec(command, commandArguments, options);
  };

  const hc: HcRuntime = { exec, connect: hcFake.connect, cwd: agentDirectory };
  const snapshotRoot = join(agentDirectory, 'tmp', 'tau-worker-packages');

  const listTerminals = (rows: { assignmentId: string; state: string }[]): void => {
    const terminals = rows.map((row) => ({ address: `t-${row.assignmentId}`, state: row.state }));

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
    snapshotRoot,
    scratchRoot: scratchRootFor(agentDirectory),
    listTerminals,
  };
};

const bornAt = (folder: string): number => {
  const stats = statSync(folder);

  return stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
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

  const result = await sweepWorkerFolders(hc, agentDirectory, bornAt(folder) + 2 * minute, []);

  expect(existsSync(folder)).toBe(false);
  expect(result).toEqual({ removed: [folder], errors: [] });
});

it('removes the scratch folder of a worker hc no longer lists', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');

  listTerminals([]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(folder) + 2 * minute, []);

  expect(existsSync(folder)).toBe(false);
});

it('keeps the scratch folder of a running worker', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, null);
  const folder = makeFolder(scratchRoot, runningId);

  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  const result = await sweepWorkerFolders(hc, agentDirectory, bornAt(folder) + 2 * minute, []);

  expect(existsSync(folder)).toBe(true);
  expect(result).toEqual({ removed: [], errors: [] });
});

it('removes nothing when the hc list fails', async () => {
  const { agentDirectory, hcFake, hc, scratchRoot, snapshotRoot } = setup();
  const scratch = makeFolder(scratchRoot, 'assignment-a');
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  hcFake.fail('ls', 'boom', 1);

  const now = Math.max(bornAt(scratch), bornAt(snapshot)) + 25 * hour;
  const result = await sweepWorkerFolders(hc, agentDirectory, now, []);

  expect(existsSync(scratch)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
  expect(result).toEqual({ removed: [], errors: [] });
});

it("keeps every snapshot when a running worker's assignment file is missing", async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  listTerminals([{ assignmentId: 'assignment-without-file', state: 'live' }]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(snapshot) + 25 * hour, []);

  expect(existsSync(snapshot)).toBe(true);
});

it("keeps every snapshot when a running worker's assignment file is malformed", async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const path = assignmentPath('assignment-malformed');

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ not json');

  listTerminals([{ assignmentId: 'assignment-malformed', state: 'live' }]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(snapshot) + 25 * hour, []);

  expect(existsSync(snapshot)).toBe(true);
});

it('removes an unused snapshot older than a day and keeps the one a running worker names', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const unused = makeFolder(snapshotRoot, 'snapshot-unused');
  const used = makeFolder(snapshotRoot, 'snapshot-used');
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, 'snapshot-used');

  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  const now = Math.max(bornAt(unused), bornAt(used)) + 25 * hour;
  const result = await sweepWorkerFolders(hc, agentDirectory, now, []);

  expect(existsSync(unused)).toBe(false);
  expect(existsSync(used)).toBe(true);
  expect(result).toEqual({ removed: [unused], errors: [] });
});

it('keeps the old snapshot a starting follow-up reuses', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');

  listTerminals([]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(snapshot) + 25 * hour, [
    { assignmentId: 'follow-up', running: true, packageSnapshot: 'snapshot-source' },
  ]);

  expect(existsSync(snapshot)).toBe(true);
});

it('keeps a snapshot just under a day old when no terminal names it', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');

  listTerminals([]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(snapshot) + 24 * hour - 1000, []);

  expect(existsSync(snapshot)).toBe(true);
});

it('keeps the scratch folder of a starting launch', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-starting');

  listTerminals([]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(folder) + 2 * minute, [
    { assignmentId: 'assignment-starting', running: true, packageSnapshot: null },
  ]);

  expect(existsSync(folder)).toBe(true);
});

it('ignores files in the folder roots and a missing root', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();

  makeFolder(scratchRoot, 'assignment-a');
  writeFileSync(join(scratchRoot, 'stray-file'), 'x');

  listTerminals([]);

  const result = await sweepWorkerFolders(hc, agentDirectory, Date.now() + 2 * minute, []);

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

  const result = await sweepWorkerFolders(hc, agentDirectory, bornAt(target) + 2 * minute, []);

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

  await sweepWorkerFolders(hc, agentDirectory, now, []);

  expect(existsSync(folder)).toBe(false);
});

it('dates a folder by its modification time when the birth time is 0', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');
  const now = bornAt(folder) + 2 * minute;

  replaceStat(folder, () => Promise.resolve({ birthtimeMs: 0, mtimeMs: now - 30_000 }));
  listTerminals([]);

  await sweepWorkerFolders(hc, agentDirectory, now, []);

  expect(existsSync(folder)).toBe(true);
});

it('skips a folder that vanishes while the sweep reads it', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const vanishing = makeFolder(scratchRoot, 'assignment-vanishing');
  const staying = makeFolder(scratchRoot, 'assignment-staying');
  replaceStat(vanishing, () => failure('gone', 'ENOENT'));

  listTerminals([]);

  const result = await sweepWorkerFolders(hc, agentDirectory, bornAt(staying) + 2 * minute, []);

  expect(existsSync(staying)).toBe(false);
  expect(result).toEqual({ removed: [staying], errors: [] });
});

it('fails the sweep when a folder cannot be read for another reason', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');
  replaceStat(folder, () => failure('denied', 'EACCES'));

  listTerminals([]);

  await expect(sweepWorkerFolders(hc, agentDirectory, Date.now(), [])).rejects.toThrow('denied');
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
  const result = await sweepWorkerFolders(hc, agentDirectory, now, []);

  expect(existsSync(scratch)).toBe(false);
  expect(existsSync(snapshot)).toBe(false);
  expect(result.errors).toEqual([]);
});

it('does not let a running worker without a snapshot protect snapshots', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, null);

  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(snapshot) + 25 * hour, []);

  expect(existsSync(snapshot)).toBe(false);
});

it('does not read the assignment of a finished worker for its snapshot', async () => {
  const { agentDirectory, hc, snapshotRoot, listTerminals } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');

  listTerminals([{ assignmentId: 'assignment-without-file', state: 'finished' }]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(snapshot) + 25 * hour, []);

  expect(existsSync(snapshot)).toBe(false);
});

it('keeps the scratch folder and snapshot of a running worker that hc ls lists without labels', async () => {
  const { agentDirectory, hc, scratchRoot, snapshotRoot, listTerminals } = setup();
  const runningId = await saveAssignmentWithSnapshot(agentDirectory, 'snapshot-used');
  const scratch = makeFolder(scratchRoot, runningId);
  const snapshot = makeFolder(snapshotRoot, 'snapshot-used');

  listTerminals([{ assignmentId: runningId, state: 'live' }]);

  const now = Math.max(bornAt(scratch), bornAt(snapshot)) + 25 * hour;

  await sweepWorkerFolders(hc, agentDirectory, now, []);

  expect(existsSync(scratch)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
});

it('removes the scratch folder of a finished worker inside the launch grace', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');

  listTerminals([{ assignmentId: 'assignment-a', state: 'finished' }]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(folder) + 5_000, []);

  expect(existsSync(folder)).toBe(false);
});

it('keeps a scratch folder no terminal names inside the launch grace', async () => {
  const { agentDirectory, hc, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');

  listTerminals([]);

  await sweepWorkerFolders(hc, agentDirectory, bornAt(folder) + 5_000, []);

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
  {
    name: 'hc get fails for a live terminal',
    arrange: ({ details, listTerminals }) => {
      listTerminals([{ assignmentId: 'assignment-live', state: 'live' }]);
      details.delete('t-assignment-live');
    },
  },
  {
    name: 'hc get returns malformed output for a live terminal',
    arrange: ({ details, listTerminals }) => {
      listTerminals([{ assignmentId: 'assignment-live', state: 'live' }]);
      details.set('t-assignment-live', 'not json');
    },
  },
  {
    name: 'hc get returns a terminal without a state for a live terminal',
    arrange: ({ details, listTerminals }) => {
      listTerminals([{ assignmentId: 'assignment-live', state: 'live' }]);
      details.set('t-assignment-live', JSON.stringify({ address: 't-assignment-live' }));
    },
  },
];

it.each(readFailures)('removes nothing when $name', async ({ arrange }) => {
  const state = setup();
  const scratch = makeFolder(state.scratchRoot, 'assignment-a');
  const snapshot = makeFolder(state.snapshotRoot, 'snapshot-a');

  arrange(state);

  const now = Math.max(bornAt(scratch), bornAt(snapshot)) + 25 * hour;
  const result = await sweepWorkerFolders(state.hc, state.agentDirectory, now, []);

  expect(existsSync(scratch)).toBe(true);
  expect(existsSync(snapshot)).toBe(true);
  expect(result).toEqual({ removed: [], errors: [] });
});

it('still removes folders when hc get fails for a finished terminal', async () => {
  const { agentDirectory, hc, details, scratchRoot, listTerminals } = setup();
  const folder = makeFolder(scratchRoot, 'assignment-a');

  listTerminals([{ assignmentId: 'assignment-gone', state: 'finished' }]);
  details.delete('t-assignment-gone');

  await sweepWorkerFolders(hc, agentDirectory, bornAt(folder) + 2 * minute, []);

  expect(existsSync(folder)).toBe(false);
});
