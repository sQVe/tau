import type { CheckRecord } from './checkRecord.js';

export interface CheckIdentity {
  tree: string | null;
  argv: string[];
}

export type RecordRead =
  | {
      status: 'valid';
      record: CheckRecord;
    }
  | { status: 'missing' }
  | { status: 'malformed' };

export interface SavedLog {
  logPath: string;
  read: RecordRead;
  logExists: boolean;
}

type CheckState = Pick<CheckIdentity, 'tree'>;

export type ReuseDecision = { status: 'reuse'; logPath: string } | { status: 'run' };

export const sameArgv = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((argument, index) => argument === right[index]);

const sameState = (left: CheckState, right: CheckState): boolean => left.tree === right.tree;

export const sameReusableState = (before: CheckIdentity, after: CheckIdentity): boolean =>
  before.tree !== null && sameState(before, after);

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
  if (current.tree === null) {
    return { status: 'run' };
  }

  const match = findStateRecord(current, saved);

  if (match !== undefined && matchesPassingRecord(current, match.read)) {
    return { status: 'reuse', logPath: match.logPath };
  }

  return { status: 'run' };
};
