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

export type ReuseDecision = { status: 'reuse'; logPath: string } | { status: 'run' };

const sameArgv = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((argument, index) => argument === right[index]);

const sameState = (left: CheckIdentity, right: CheckIdentity): boolean =>
  left.head === right.head && left.base === right.base && left.fingerprint === right.fingerprint;

const sameIdentity = (left: CheckIdentity, right: CheckIdentity): boolean =>
  sameState(left, right) && sameArgv(left.argv, right.argv);

// A result may be reused or saved for reuse only when the state has a fingerprint.
export const sameReusableState = (before: CheckIdentity, after: CheckIdentity): boolean =>
  before.fingerprint !== null && sameState(before, after);

const matchesPassingRecord = (current: CheckIdentity, read: RecordRead): boolean =>
  read.status === 'valid' && read.record.passed && sameIdentity(current, read.record);

// Reuses the first saved log, newest first, whose passing record matches the current identity.
export const decideReuse = (current: CheckIdentity, saved: SavedLog[]): ReuseDecision => {
  if (current.fingerprint === null) {
    return { status: 'run' };
  }

  const match = saved.find((log) => log.logExists && matchesPassingRecord(current, log.read));

  return match === undefined ? { status: 'run' } : { status: 'reuse', logPath: match.logPath };
};
