export interface CheckIdentity {
  head: string;
  base: string | null;
  argv: string[];
  // null when a submodule has changes the fingerprint cannot see, so the state is never reusable.
  fingerprint: string | null;
}

export type RecordRead =
  | {
      status: 'valid';
      record: CheckIdentity & { version: 2; fingerprint: string; passed: boolean };
    }
  | { status: 'missing' }
  | { status: 'malformed' };

export interface SavedLog {
  logPath: string;
  read: RecordRead;
  logExists: boolean;
}

type CheckState = Pick<CheckIdentity, 'head' | 'base' | 'fingerprint'>;

export type ReuseDecision = { status: 'reuse'; logPath: string } | { status: 'run' };

const sameArgv = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((argument, index) => argument === right[index]);

const sameState = (left: CheckState, right: CheckState): boolean =>
  left.head === right.head && left.base === right.base && left.fingerprint === right.fingerprint;

// A result may be reused or saved for reuse only when the state has a fingerprint.
export const sameReusableState = (before: CheckIdentity, after: CheckIdentity): boolean =>
  before.fingerprint !== null && sameState(before, after);

// Finds the newest saved log of the state, passed or failed. A log whose file is gone is skipped.
export const findStateRecord = (current: CheckState, saved: SavedLog[]): SavedLog | undefined =>
  saved.find(
    (log) => log.logExists && log.read.status === 'valid' && sameState(current, log.read.record),
  );

const matchesPassingRecord = (current: CheckIdentity, read: RecordRead): boolean =>
  read.status === 'valid' && read.record.passed && sameArgv(current.argv, read.record.argv);

// Takes the newest record for the state and reuses its log only when it passed with the same
// command. A newer failing record or another command runs the check again, so the run saves a
// newer record that readers of the newest record see.
export const decideReuse = (current: CheckIdentity, saved: SavedLog[]): ReuseDecision => {
  if (current.fingerprint === null) {
    return { status: 'run' };
  }

  const match = findStateRecord(current, saved);

  if (match !== undefined && matchesPassingRecord(current, match.read)) {
    return { status: 'reuse', logPath: match.logPath };
  }

  return { status: 'run' };
};
