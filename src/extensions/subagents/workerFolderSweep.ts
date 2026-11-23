import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { errorMessage, isMissingFile } from '../../errors.js';
import { withFileLock } from '../../fileLock/fileLock.js';
import { get, ls } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { readAssignment } from './assignment.js';
import {
  removeSnapshotDirectory,
  snapshotDirectoryFor,
  snapshotRootFor,
} from './packageSnapshot.js';
import { clearSnapshotMarker, markSnapshotUnused, readUnusedSince } from './snapshotMarker.js';
import {
  decideUnreadListRemoval,
  decideWorkerFolderRemoval,
  isWorkerCandidate,
} from './workerFolderDecision.js';
import type {
  SnapshotFolder,
  StartingWorker,
  WorkerFolder,
  WorkerFolderRemoval,
  WorkerTerminalFact,
} from './workerFolderDecision.js';
import { assignmentPrefixFromName } from './workerName.js';
import { removeScratchFolder, scratchRootFor } from './workerScratch.js';

export interface WorkerFolderSweep {
  removed: string[];
  errors: string[];
}

interface TerminalRead {
  fact: WorkerTerminalFact | undefined;
  finishedAddress: string | undefined;
  error: string | undefined;
}

interface TerminalFacts {
  terminals: readonly WorkerTerminalFact[] | 'unread';
  finishedAddresses: string[];
  errors: string[];
}

const terminalReadTimeout = 10_000;

const sweepLockPath = (agentDirectory: string): string =>
  join(agentDirectory, '.tau-worker-folder-sweep.lock');

const readBornAt = async (path: string): Promise<number | undefined> => {
  try {
    const stats = await stat(path);

    return stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }

    throw error;
  }
};

const readDirectoryNames = async (root: string): Promise<string[]> => {
  let entries: { name: string; isDirectory: () => boolean }[];

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }

  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

const readFolders = async (root: string): Promise<WorkerFolder[]> => {
  const names = await readDirectoryNames(root);

  const folders = await Promise.all(
    names.map(async (name) => ({ name, bornAt: await readBornAt(join(root, name)) })),
  );

  return folders.flatMap(({ name, bornAt }) => (bornAt === undefined ? [] : [{ name, bornAt }]));
};

const readSnapshots = async (root: string): Promise<SnapshotFolder[]> => {
  const names = await readDirectoryNames(root);

  return Promise.all(
    names.map(async (name) => ({ name, unusedSince: await readUnusedSince(join(root, name)) })),
  );
};

const readPackageSnapshot = async (label: string): Promise<string | null> => {
  try {
    const assignment = await readAssignment(label);

    if (assignment === undefined) {
      return 'unread';
    }

    return assignment.packageSnapshot === null ? null : basename(assignment.packageSnapshot);
  } catch {
    return 'unread';
  }
};

const terminalReadLimit = 4;

const mapWithLimit = async <Item, Result>(
  items: readonly Item[],
  limit: number,
  map: (item: Item) => Promise<Result>,
): Promise<Result[]> => {
  const queue = items.entries();
  const results: Result[] = [];

  const drain = async (): Promise<void> => {
    for (const [index, item] of queue) {
      // oxlint-disable-next-line no-await-in-loop -- Each loop is one of the limited readers.
      results[index] = await map(item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, drain));

  return results;
};

const isFinished = (terminal: Pick<HcTerminal, 'state'>): boolean => terminal.state === 'finished';

// hc lists terminals without labels, so each label comes from `hc get`.
const readTerminalFact = async (hc: HcRuntime, listed: HcTerminal): Promise<TerminalRead> => {
  let terminal: HcTerminal;

  try {
    terminal = await get(hc, listed.address, { timeout: terminalReadTimeout });

    if (terminal.address !== listed.address) {
      throw new Error(`the reply named ${terminal.address}`);
    }
  } catch (error) {
    return {
      fact: { kind: 'unread', assignmentPrefix: assignmentPrefixFromName(listed.name) },
      finishedAddress: undefined,
      error: `Reading terminal ${listed.address} failed: ${errorMessage(error)}. Kept its folders.`,
    };
  }

  const finished = isFinished(terminal);
  const finishedAddress = finished ? listed.address : undefined;
  const label = terminal.labels?.['tau.assignment'];

  if (label === undefined || label === '') {
    return { fact: undefined, finishedAddress, error: undefined };
  }

  const fact: WorkerTerminalFact = {
    kind: 'read',
    assignmentId: basename(dirname(label)),
    running: !finished,
    packageSnapshot: finished ? null : await readPackageSnapshot(label),
  };

  return { fact, finishedAddress, error: undefined };
};

const readTerminalFacts = async (hc: HcRuntime): Promise<TerminalFacts> => {
  let list: Awaited<ReturnType<typeof ls>>;

  try {
    list = await ls(hc, { all: true });
  } catch (error) {
    return {
      terminals: 'unread',
      finishedAddresses: [],
      errors: [`Listing hc terminals failed: ${errorMessage(error)}. Removed nothing.`],
    };
  }

  const listedFinished = list.terminals.filter(isFinished).map((terminal) => terminal.address);

  const candidates = list.terminals.filter(isWorkerCandidate);

  const reads = await mapWithLimit(candidates, terminalReadLimit, (listed) =>
    readTerminalFact(hc, listed),
  );

  return {
    terminals: reads.flatMap(({ fact }) => (fact === undefined ? [] : [fact])),
    finishedAddresses: [
      ...listedFinished,
      ...reads.flatMap(({ finishedAddress }) =>
        finishedAddress === undefined ? [] : [finishedAddress],
      ),
    ],
    errors: reads.flatMap(({ error }) => (error === undefined ? [] : [error])),
  };
};

const removeDecidedFolders = async (
  agentDirectory: string,
  decision: WorkerFolderRemoval,
): Promise<WorkerFolderSweep> => {
  const scratchRoot = scratchRootFor(agentDirectory);
  const snapshotRoot = snapshotRootFor(agentDirectory);

  const scratchErrors = await Promise.all(
    decision.scratch.map((name) => removeScratchFolder(agentDirectory, name)),
  );

  const snapshotErrors = await Promise.all(
    decision.snapshots.map((name) =>
      removeSnapshotDirectory({
        agentDirectory,
        directory: snapshotDirectoryFor(agentDirectory, name),
        snapshotName: name,
      }),
    ),
  );

  const removals = [
    ...decision.scratch.map((name, index) => ({
      path: join(scratchRoot, name),
      error: scratchErrors[index],
    })),
    ...decision.snapshots.map((name, index) => ({
      path: join(snapshotRoot, name),
      error: snapshotErrors[index],
    })),
  ];

  return {
    removed: removals.filter((removal) => removal.error === undefined).map(({ path }) => path),
    errors: removals.flatMap(({ error }) => (error === undefined ? [] : [error])),
  };
};

const updateUnusedMarkers = async (
  agentDirectory: string,
  decision: WorkerFolderRemoval,
  now: number,
): Promise<string[]> => {
  const results = await Promise.all([
    ...decision.markUnused.map((name) => markSnapshotUnused(agentDirectory, name, now)),
    ...decision.clearUnused.map((name) => clearSnapshotMarker(agentDirectory, name)),
  ]);

  return results.flatMap((error) => (error === undefined ? [] : [error]));
};

const sweepUnderLock = async (
  hc: HcRuntime,
  agentDirectory: string,
  readNow: () => number,
  starting: readonly StartingWorker[],
): Promise<WorkerFolderSweep> => {
  const now = readNow();

  const { terminals, finishedAddresses, errors: readErrors } = await readTerminalFacts(hc);

  const facts = {
    now,
    scratch: await readFolders(scratchRootFor(agentDirectory)),
    snapshots: await readSnapshots(snapshotRootFor(agentDirectory)),
    terminals:
      terminals === 'unread'
        ? terminals
        : [
            ...terminals,
            ...finishedAddresses.map((terminalAddress): WorkerTerminalFact => ({
              kind: 'finished',
              terminalAddress,
            })),
            ...starting,
          ],
  };

  const decision =
    terminals === 'unread'
      ? decideUnreadListRemoval(facts.snapshots, starting)
      : decideWorkerFolderRemoval(facts);

  const markerErrors = await updateUnusedMarkers(agentDirectory, decision, now);
  const removal = await removeDecidedFolders(agentDirectory, decision);

  return {
    removed: removal.removed,
    errors: [...readErrors, ...markerErrors, ...removal.errors],
  };
};

export const withFolderSweepLock = <Value>(
  agentDirectory: string,
  signal: AbortSignal | undefined,
  run: () => Promise<Value>,
): Promise<Value> =>
  withFileLock(
    {
      lockPath: sweepLockPath(agentDirectory),
      checkout: agentDirectory,
      signal,
      pollMilliseconds: 25,
      onWaiting: () => undefined,
      cancelled: () => new Error('The worker folder sweep lock was cancelled.'),
    },
    run,
  );

export const sweepWorkerFolders = async (
  hc: HcRuntime,
  agentDirectory: string,
  readNow: () => number,
  starting: readonly StartingWorker[],
): Promise<WorkerFolderSweep> =>
  withFolderSweepLock(agentDirectory, undefined, () =>
    sweepUnderLock(hc, agentDirectory, readNow, starting),
  );
