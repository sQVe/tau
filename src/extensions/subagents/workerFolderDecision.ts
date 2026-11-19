export interface WorkerFolder {
  name: string;
  bornAt: number;
}

export interface WorkerTerminalFact {
  assignmentId: string;
  running: boolean;
  // A snapshot folder name, null for none, or 'unread' when the assignment could not be read.
  packageSnapshot: string | null;
}

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

const runningTerminals = (terminals: readonly WorkerTerminalFact[]): WorkerTerminalFact[] =>
  terminals.filter((terminal) => terminal.running);

const namesAssignment = (terminals: readonly WorkerTerminalFact[], name: string): boolean =>
  terminals.some((terminal) => terminal.assignmentId === name);

// The launch grace protects only a folder that no terminal names.
const isStaleScratch = (
  folder: WorkerFolder,
  terminals: readonly WorkerTerminalFact[],
  now: number,
): boolean =>
  namesAssignment(terminals, folder.name) || ageAtLeast(folder, now, scratchLaunchGrace);

const hasUnreadSnapshot = (running: readonly WorkerTerminalFact[]): boolean =>
  running.some((terminal) => terminal.packageSnapshot === 'unread');

const isNamedSnapshot = (running: readonly WorkerTerminalFact[], name: string): boolean =>
  running.some((terminal) => terminal.packageSnapshot === name);

export const decideWorkerFolderRemoval = (facts: WorkerFolderFacts): WorkerFolderRemoval => {
  if (facts.terminals === 'unread') {
    return { scratch: [], snapshots: [] };
  }

  const { terminals } = facts;
  const running = runningTerminals(terminals);

  const scratch = facts.scratch
    .filter(
      (folder) =>
        !namesAssignment(running, folder.name) && isStaleScratch(folder, terminals, facts.now),
    )
    .map((folder) => folder.name);

  const snapshots = hasUnreadSnapshot(running)
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
