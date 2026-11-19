import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { isMissingFile } from '../../errors.js';
import { get, ls } from '../../hc/hc.js';
import type { HcRuntime, HcTerminal } from '../../hc/hc.js';
import { readAssignment } from './assignment.js';
import {
  removeSnapshotDirectory,
  snapshotDirectoryFor,
  snapshotRootFor,
} from './packageSnapshot.js';
import { decideWorkerFolderRemoval } from './workerFolderDecision.js';
import type { WorkerFolder, WorkerTerminalFact } from './workerFolderDecision.js';
import { removeScratchDirectory, scratchRootFor } from './workerScratch.js';

export interface WorkerFolderSweep {
  removed: string[];
  errors: string[];
}

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

const readFolders = async (root: string): Promise<WorkerFolder[]> => {
  let entries: { name: string; isDirectory: () => boolean }[];

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }

  const directories = entries.filter((entry) => entry.isDirectory());

  const folders = await Promise.all(
    directories.map(async (entry) => ({
      name: entry.name,
      bornAt: await readBornAt(join(root, entry.name)),
    })),
  );

  return folders.flatMap(({ name, bornAt }) => (bornAt === undefined ? [] : [{ name, bornAt }]));
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

const isFinished = (terminal: Pick<HcTerminal, 'state'>): boolean => terminal.state === 'finished';

// hc lists terminals without labels, so each label comes from `hc get`.
const readTerminalFact = async (
  hc: HcRuntime,
  listed: HcTerminal,
): Promise<WorkerTerminalFact | undefined> => {
  let terminal: HcTerminal;

  try {
    terminal = await get(hc, listed.address);
  } catch (error) {
    if (isFinished(listed)) {
      return undefined;
    }

    throw error;
  }

  const label = terminal.labels?.['tau.assignment'];

  if (label === undefined || label === '') {
    return undefined;
  }

  const running = !isFinished(terminal);

  return {
    assignmentId: basename(dirname(label)),
    running,
    packageSnapshot: running ? await readPackageSnapshot(label) : null,
  };
};

const readTerminalFacts = async (
  hc: HcRuntime,
): Promise<readonly WorkerTerminalFact[] | 'unread'> => {
  try {
    const list = await ls(hc, { all: true });
    const facts = await Promise.all(list.terminals.map((listed) => readTerminalFact(hc, listed)));

    return facts.filter((fact) => fact !== undefined);
  } catch {
    return 'unread';
  }
};

export const sweepWorkerFolders = async (
  hc: HcRuntime,
  agentDirectory: string,
  now: number,
  starting: readonly WorkerTerminalFact[],
): Promise<WorkerFolderSweep> => {
  const scratchRoot = scratchRootFor(agentDirectory);
  const snapshotRoot = snapshotRootFor(agentDirectory);
  const terminals = await readTerminalFacts(hc);

  const facts = {
    now,
    scratch: await readFolders(scratchRoot),
    snapshots: await readFolders(snapshotRoot),
    terminals: terminals === 'unread' ? terminals : [...terminals, ...starting],
  };

  const decision = decideWorkerFolderRemoval(facts);

  const scratchErrors = await Promise.all(
    decision.scratch.map((name) => removeScratchDirectory(agentDirectory, name)),
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
