export interface WorkerFolder {
  name: string;
  bornAt: number;
}

interface ReadTerminalFact {
  kind: 'read';
  assignmentId: string;
  running: boolean;
  // A snapshot folder name, null for none, or 'unread' when the assignment could not be read.
  packageSnapshot: string | null;
}

// A terminal whose labels could not be read. The prefix is the start of its assignment id when its
// name gives one.
interface UnreadTerminalFact {
  kind: 'unread';
  assignmentPrefix: string | undefined;
}

export type WorkerTerminalFact = ReadTerminalFact | UnreadTerminalFact;

export interface WorkerFolderFacts {
  now: number;
  scratch: readonly WorkerFolder[];
  snapshots: readonly WorkerFolder[];
  terminals: readonly WorkerTerminalFact[] | 'unread';
}

export interface WorkerFolderRemoval {
  scratch: string[];
  snapshots: string[];
}

export const scratchLaunchGrace = 60_000;
export const snapshotFollowUpWindow = 86_400_000;

const ageAtLeast = (folder: WorkerFolder, now: number, limit: number): boolean => {
  return now - folder.bornAt >= limit;
};

const isRead = (terminal: WorkerTerminalFact): terminal is ReadTerminalFact =>
  terminal.kind === 'read';

const isUnread = (terminal: WorkerTerminalFact): terminal is UnreadTerminalFact =>
  terminal.kind === 'unread';

const runningTerminals = (terminals: readonly ReadTerminalFact[]): ReadTerminalFact[] =>
  terminals.filter((terminal) => terminal.running);

const namesAssignment = (terminals: readonly ReadTerminalFact[], name: string): boolean =>
  terminals.some((terminal) => terminal.assignmentId === name);

const keepsEveryScratchFolder = (terminal: UnreadTerminalFact): boolean =>
  terminal.assignmentPrefix === undefined;

const keepsScratchFolder = (terminal: UnreadTerminalFact, name: string): boolean =>
  terminal.assignmentPrefix !== undefined &&
  name.replaceAll('-', '').startsWith(terminal.assignmentPrefix);

const isKeptByUnread = (unread: readonly UnreadTerminalFact[], name: string): boolean =>
  unread.some(
    (terminal) => keepsEveryScratchFolder(terminal) || keepsScratchFolder(terminal, name),
  );

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

export const decideWorkerFolderRemoval = (facts: WorkerFolderFacts): WorkerFolderRemoval => {
  if (facts.terminals === 'unread') {
    return { scratch: [], snapshots: [] };
  }

  const terminals = facts.terminals.filter(isRead);
  const unread = facts.terminals.filter(isUnread);
  const running = runningTerminals(terminals);

  const scratch = facts.scratch
    .filter(
      (folder) =>
        !namesAssignment(running, folder.name) &&
        !isKeptByUnread(unread, folder.name) &&
        isStaleScratch(folder, terminals, facts.now),
    )
    .map((folder) => folder.name);

  const keepsEverySnapshot = unread.length > 0 || hasUnreadSnapshot(running);

  const snapshots = keepsEverySnapshot
    ? []
    : facts.snapshots
        .filter(
          (folder) =>
            !isNamedSnapshot(running, folder.name) &&
            ageAtLeast(folder, facts.now, snapshotFollowUpWindow),
        )
        .map((folder) => folder.name);

  return { scratch, snapshots };
};
