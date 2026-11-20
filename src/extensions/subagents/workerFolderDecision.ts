import { assignmentPrefixFromName } from './workerName.js';

export interface WorkerFolder {
  name: string;
  bornAt: number;
}

export interface SnapshotFolder {
  name: string;
  // The modification time of the unused marker, or undefined when no marker exists.
  unusedSince: number | undefined;
}

interface ReadTerminalFact {
  kind: 'read';
  assignmentId: string;
  running: boolean;
  // A snapshot folder name, null for none, or 'unread' when the assignment could not be read.
  packageSnapshot: string | null;
}

// A worker whose launch returned but whose sweep has not read it yet.
export interface StartingWorker {
  kind: 'read';
  assignmentId: string;
  running: true;
  packageSnapshot: string | null;
  terminalAddress: string;
}

// A terminal the fresh listing or a detail read reports as finished.
interface FinishedTerminalFact {
  kind: 'finished';
  terminalAddress: string;
}

// A terminal whose labels could not be read. The prefix is the start of its assignment id when its
// name gives one.
interface UnreadTerminalFact {
  kind: 'unread';
  assignmentPrefix: string | undefined;
}

export type WorkerTerminalFact =
  | ReadTerminalFact
  | StartingWorker
  | FinishedTerminalFact
  | UnreadTerminalFact;

export interface WorkerFolderFacts {
  now: number;
  scratch: readonly WorkerFolder[];
  snapshots: readonly SnapshotFolder[];
  terminals: readonly WorkerTerminalFact[] | 'unread';
}

export interface WorkerFolderRemoval {
  scratch: string[];
  snapshots: string[];
  markUnused: string[];
  clearUnused: string[];
}

export const scratchLaunchGrace = 60_000;
export const snapshotFollowUpWindow = 86_400_000;

const ageAtLeast = (folder: WorkerFolder, now: number, limit: number): boolean => {
  return now - folder.bornAt >= limit;
};

const isRead = (terminal: WorkerTerminalFact): terminal is ReadTerminalFact =>
  terminal.kind === 'read';

const isStarting = (terminal: ReadTerminalFact): terminal is StartingWorker =>
  terminal.running && 'terminalAddress' in terminal && typeof terminal.terminalAddress === 'string';

const isUnread = (terminal: WorkerTerminalFact): terminal is UnreadTerminalFact =>
  terminal.kind === 'unread';

const isFinishedFact = (terminal: WorkerTerminalFact): terminal is FinishedTerminalFact =>
  terminal.kind === 'finished';

// A launch hint yields to a matching finish, since the lock need not grant claims in arrival order.
const runningTerminals = (terminals: readonly WorkerTerminalFact[]): ReadTerminalFact[] => {
  const finishedList = terminals.filter(isFinishedFact);
  const finished = new Set(finishedList.map((terminal) => terminal.terminalAddress));

  return terminals
    .filter(isRead)
    .filter(
      (terminal) =>
        terminal.running && !(isStarting(terminal) && finished.has(terminal.terminalAddress)),
    );
};

const namesAssignment = (terminals: readonly ReadTerminalFact[], name: string): boolean =>
  terminals.some((terminal) => terminal.assignmentId === name);

const keepsScratchFolder = (terminal: UnreadTerminalFact, name: string): boolean =>
  terminal.assignmentPrefix === undefined ||
  name.replaceAll('-', '').startsWith(terminal.assignmentPrefix);

const isKeptByUnread = (unread: readonly UnreadTerminalFact[], name: string): boolean =>
  unread.some((terminal) => keepsScratchFolder(terminal, name));

// The launch grace protects only a folder that no terminal names.
const isStaleScratch = (
  folder: WorkerFolder,
  terminals: readonly ReadTerminalFact[],
  now: number,
): boolean =>
  namesAssignment(terminals, folder.name) || ageAtLeast(folder, now, scratchLaunchGrace);

const hasUnreadSnapshot = (running: readonly ReadTerminalFact[]): boolean =>
  running.some((terminal) => terminal.packageSnapshot === 'unread');

const isNamedSnapshot = (running: readonly ReadTerminalFact[], name: string): boolean =>
  running.some((terminal) => terminal.packageSnapshot === name);

const hasUnusedMarker = (folder: SnapshotFolder): boolean => folder.unusedSince !== undefined;

const isUnusedForWindow = (folder: SnapshotFolder, now: number): boolean =>
  folder.unusedSince !== undefined && now - folder.unusedSince >= snapshotFollowUpWindow;

const isFinished = (terminal: { state: string }): boolean => terminal.state === 'finished';

export const isWorkerCandidate = (listed: {
  state: string;
  name?: string | null | undefined;
}): boolean => {
  if (isFinished(listed)) {
    return false;
  }

  const hasNoName = listed.name === undefined || listed.name === null;

  return hasNoName || assignmentPrefixFromName(listed.name) !== undefined;
};

const decideSnapshots = (
  snapshots: readonly SnapshotFolder[],
  running: readonly ReadTerminalFact[],
  keepsEverySnapshot: boolean,
  now: number,
): Pick<WorkerFolderRemoval, 'snapshots' | 'markUnused' | 'clearUnused'> => {
  const named = snapshots.filter((folder) => isNamedSnapshot(running, folder.name));
  const unnamed = snapshots.filter((folder) => !isNamedSnapshot(running, folder.name));
  const clearUnused = named.filter(hasUnusedMarker).map((folder) => folder.name);

  if (keepsEverySnapshot) {
    return { snapshots: [], markUnused: [], clearUnused };
  }

  return {
    snapshots: unnamed
      .filter((folder) => isUnusedForWindow(folder, now))
      .map((folder) => folder.name),
    markUnused: unnamed.filter((folder) => !hasUnusedMarker(folder)).map((folder) => folder.name),
    clearUnused,
  };
};

export const decideWorkerFolderRemoval = (facts: WorkerFolderFacts): WorkerFolderRemoval => {
  if (facts.terminals === 'unread') {
    return { scratch: [], snapshots: [], markUnused: [], clearUnused: [] };
  }

  const terminals = facts.terminals.filter(isRead);
  const unread = facts.terminals.filter(isUnread);
  const running = runningTerminals(facts.terminals);

  const scratch = facts.scratch
    .filter(
      (folder) =>
        !namesAssignment(running, folder.name) &&
        !isKeptByUnread(unread, folder.name) &&
        isStaleScratch(folder, terminals, facts.now),
    )
    .map((folder) => folder.name);

  const keepsEverySnapshot = unread.length > 0 || hasUnreadSnapshot(running);

  return {
    scratch,
    ...decideSnapshots(facts.snapshots, running, keepsEverySnapshot, facts.now),
  };
};

// The list of terminals could not be read, so nothing is removed or marked. A worker that is
// starting is known without the list, and its snapshot loses any marker.
export const decideUnreadListRemoval = (
  snapshots: readonly SnapshotFolder[],
  starting: readonly StartingWorker[],
): WorkerFolderRemoval => {
  const running = runningTerminals(starting);

  return {
    scratch: [],
    snapshots: [],
    markUnused: [],
    clearUnused: snapshots
      .filter((folder) => hasUnusedMarker(folder) && isNamedSnapshot(running, folder.name))
      .map((folder) => folder.name),
  };
};
