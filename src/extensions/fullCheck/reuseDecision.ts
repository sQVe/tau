export interface CheckIdentity {
  head: string;
  base: string | null;
  argv: string[];
  // null when a submodule has changes the fingerprint cannot see, so the state is never reusable.
  fingerprint: string | null;
}

export interface SavedLog {
  logPath: string;
  // undefined when the record is missing or malformed.
  record: CheckIdentity | undefined;
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

// Reuses the first saved log, newest first, whose record matches the current identity.
export const decideReuse = (current: CheckIdentity, saved: SavedLog[]): ReuseDecision => {
  if (current.fingerprint === null) {
    return { status: 'run' };
  }

  const match = saved.find(
    (log) => log.logExists && log.record !== undefined && sameIdentity(current, log.record),
  );

  return match === undefined ? { status: 'run' } : { status: 'reuse', logPath: match.logPath };
};
