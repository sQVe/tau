export interface CheckIdentity {
  head: string;
  base: string | null;
  argv: string[];
  fingerprint: string;
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

// Reuses the first saved log, newest first, whose record matches the current identity.
export const decideReuse = (current: CheckIdentity, saved: SavedLog[]): ReuseDecision => {
  const match = saved.find(
    (log) => log.logExists && log.record !== undefined && sameIdentity(current, log.record),
  );

  return match === undefined ? { status: 'run' } : { status: 'reuse', logPath: match.logPath };
};
