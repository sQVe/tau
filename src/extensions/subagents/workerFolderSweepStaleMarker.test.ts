import { existsSync, mkdirSync, statSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';

import { createHcFake } from '../../../tests/hcFake.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { holdFileLock } from '../../fileLock/fileLock.js';
import type { HcRuntime } from '../../hc/hc.js';
import type { StartingWorker } from './workerFolderDecision.js';
import { sweepWorkerFolders } from './workerFolderSweep.js';

interface HeldList {
  called: Promise<void>;
  release: () => void;
}

interface HeldLink {
  called: Promise<void>;
  release: () => void;
}

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
  const hcFake = createHcFake();
  const hc: HcRuntime = { exec: hcFake.exec, connect: hcFake.connect, cwd: agentDirectory };

  vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

  return {
    agentDirectory,
    hc,
    hcFake,
    snapshotRoot: join(agentDirectory, 'tmp', 'tau-worker-packages'),
  };
};

const sweepLockPath = (agentDirectory: string): string =>
  join(agentDirectory, '.tau-worker-folder-sweep.lock');

const unusedMarkerName = '.tau-unused-since';

const terminalList = (terminals: { address: string; state: string }[]): string =>
  JSON.stringify({ terminals });

// Holds the first `hc ls` reply, so a sweep keeps the evidence it read before the hold.
const holdNextList = (hc: HcRuntime): HeldList => {
  const realExec = hc.exec;
  const called = Promise.withResolvers<undefined>();
  const held = Promise.withResolvers<Awaited<ReturnType<HcRuntime['exec']>>>();
  let captured: Awaited<ReturnType<HcRuntime['exec']>> | undefined;
  let taken = false;
  let released = false;

  const release = (): void => {
    released = true;

    if (captured !== undefined) {
      held.resolve(captured);
    }
  };

  hc.exec = (command, commandArguments, options) => {
    if (taken || commandArguments[0] !== 'ls') {
      return realExec(command, commandArguments, options);
    }

    taken = true;

    const result = realExec(command, commandArguments, options);

    void result.then(
      (value) => {
        captured = value;
        called.resolve(undefined);

        if (released) {
          held.resolve(value);
        }
      },
      (error: unknown) => {
        called.reject(error);
        held.reject(error);
      },
    );

    return held.promise;
  };

  return { called: called.promise, release };
};

const actualFsPromises = await vi.importActual<typeof fsPromises>('node:fs/promises');

// Holds the first hard link, so a queued lock claim cannot publish its generation yet.
const holdNextLink = (): HeldLink => {
  const link = vi.mocked(fsPromises.link);
  const original = link.getMockImplementation() ?? actualFsPromises.link;
  const called = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  let taken = false;

  link.mockImplementation(((source: string, target: string) => {
    if (taken) {
      return original(source, target);
    }

    taken = true;
    called.resolve(undefined);

    return released.promise.then(() => original(source, target));
  }) as typeof fsPromises.link);

  onTestFinished(() => {
    link.mockImplementation(original);
  });

  return {
    called: called.promise,
    release: () => {
      released.resolve(undefined);
    },
  };
};

// Resolves on the waiting sweep's read of the lock generation its holder published.
const signalActiveGenerationRead = (agentDirectory: string): Promise<void> => {
  const path = `${sweepLockPath(agentDirectory)}.1`;
  const { promise, resolve } = Promise.withResolvers<undefined>();
  const readFile = vi.mocked(fsPromises.readFile);
  const original = readFile.getMockImplementation() ?? actualFsPromises.readFile;

  readFile.mockImplementation(((target: string, ...rest: never[]) => {
    if (target === path) {
      resolve(undefined);
    }

    return original(target, ...rest);
  }) as typeof fsPromises.readFile);

  onTestFinished(() => {
    readFile.mockImplementation(original);
  });

  return promise;
};

it('keeps a snapshot for a day after the follow-up that reused it ends', async () => {
  const { agentDirectory, hc, hcFake, snapshotRoot } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');
  const startedAt = Date.now();

  const followUp: StartingWorker = {
    kind: 'read',
    assignmentId: 'follow-up',
    running: true,
    packageSnapshot: 'snapshot-source',
    terminalAddress: 't-follow-up',
  };

  const pending: Promise<unknown>[] = [];

  hcFake.reply('ls', terminalList([]));

  const stale = holdNextList(hc);

  onTestFinished(async () => {
    stale.release();
    await Promise.allSettled(pending);
  });

  const staleSweep = sweepWorkerFolders(hc, agentDirectory, () => startedAt, []);

  pending.push(staleSweep);

  await stale.called;

  const contenderRead = signalActiveGenerationRead(agentDirectory);
  const launchSweep = sweepWorkerFolders(hc, agentDirectory, () => startedAt, [followUp]);

  pending.push(launchSweep);

  // On the base the launch sweep completes; with the lock it waits for the held generation.
  await Promise.race([launchSweep, contenderRead]);

  stale.release();

  await staleSweep;
  await launchSweep;

  const endedAt = startedAt + 25 * hour;

  hcFake.reply('ls', terminalList([{ address: 't-follow-up', state: 'finished' }]));

  await sweepWorkerFolders(hc, agentDirectory, () => endedAt, []);

  expect(existsSync(snapshot)).toBe(true);

  await sweepWorkerFolders(hc, agentDirectory, () => endedAt + 24 * hour, []);

  expect(existsSync(snapshot)).toBe(false);
});

it('starts the unused window after a sweep waits for the lock', async () => {
  const { agentDirectory, hc, hcFake, snapshotRoot } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-a');
  const marker = join(snapshot, unusedMarkerName);
  const startedAt = Date.now();
  let now = startedAt;

  hcFake.reply('ls', terminalList([]));

  const held = await holdFileLock({
    lockPath: sweepLockPath(agentDirectory),
    checkout: agentDirectory,
    terminal: undefined,
  });

  if (held.kind !== 'held') {
    throw new Error('Another session already holds the sweep lock.');
  }

  onTestFinished(() => held.release());

  const contenderRead = signalActiveGenerationRead(agentDirectory);
  const sweep = sweepWorkerFolders(hc, agentDirectory, () => now, []);

  await contenderRead;

  now = startedAt + 30 * minute;

  await held.release();

  await sweep;

  expect(statSync(marker).mtimeMs).toBeCloseTo(now, -1);
});

it('keeps the unused window when the end sweep overtakes the launch sweep', async () => {
  const { agentDirectory, hc, hcFake, snapshotRoot } = setup();
  const snapshot = makeFolder(snapshotRoot, 'snapshot-source');
  const marker = join(snapshot, unusedMarkerName);
  const endedAt = Date.now();

  const followUp: StartingWorker = {
    kind: 'read',
    assignmentId: 'follow-up',
    running: true,
    packageSnapshot: 'snapshot-source',
    terminalAddress: 't-follow-up',
  };

  const pending: Promise<unknown>[] = [];

  hcFake.reply('ls', terminalList([{ address: 't-follow-up', state: 'finished' }]));

  const gate = holdNextLink();

  onTestFinished(async () => {
    gate.release();
    await Promise.allSettled(pending);
  });

  const launchSweep = sweepWorkerFolders(hc, agentDirectory, () => endedAt + hour, [followUp]);

  pending.push(launchSweep);

  await gate.called;

  // The end scan wins the free lock while the launch's claim is still held at its link.
  const endSweep = sweepWorkerFolders(hc, agentDirectory, () => endedAt, []);

  pending.push(endSweep);

  await endSweep;

  expect(existsSync(marker)).toBe(true);
  expect(statSync(marker).mtimeMs).toBeCloseTo(endedAt, -1);

  gate.release();

  await launchSweep;

  expect(statSync(marker).mtimeMs).toBeCloseTo(endedAt, -1);

  await sweepWorkerFolders(hc, agentDirectory, () => endedAt + 24 * hour - 1000, []);

  expect(existsSync(snapshot)).toBe(true);

  await sweepWorkerFolders(hc, agentDirectory, () => endedAt + 24 * hour, []);

  expect(existsSync(snapshot)).toBe(false);
});
