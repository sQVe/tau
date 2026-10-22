import type { CheckState } from '../../checkRecord/identity.js';
import type { SavedLog } from '../../checkRecord/reuseDecision.js';
import type { ReviewEvidence } from '../../reviewCapture/evidence.js';

export interface CheckHeaderIdentity {
  head: string;
  status: string;
  diff: string;
}

interface CheckReason {
  field: keyof CheckHeaderIdentity | 'header' | 'read' | 'current';
  reason: string;
}

export interface CheckLog {
  path: string;
  matches: boolean;
  reasons: CheckReason[];
  excerpt: string | null;
  truncated: boolean;
}

export interface ModifiedCheckLog {
  name: string;
  modifiedAt: number | null;
  check: CheckLog;
}

type TimedCheckLog = ModifiedCheckLog & { modifiedAt: number };

export type PublicationGap =
  | { kind: 'noReview' | 'noChecks' }
  | {
      kind: 'target' | 'branch' | 'subjects' | 'reuse' | 'review' | 'markers' | 'checks';
      reason: string;
    }
  | { kind: 'reuseMismatch'; reasons: string[] }
  | { kind: 'reviewEvidence'; gap: ReviewEvidence['gaps'][number] }
  | { kind: 'check'; path: string; reasons: CheckReason[] }
  | { kind: 'checkExcerpt'; path: string }
  | { kind: 'fullCheck'; status: 'failed' | 'missing' | 'malformed' };

export type FullCheckDecision =
  | { status: 'passed' | 'failed'; logPath: string; argv: string[] }
  | { status: 'missing' | 'malformed' };

const identityFields = ['head', 'status', 'diff'] as const;
const headerNames = ['HEAD', 'Status', 'Diff'] as const;
const excerptLines = 20;
const excerptCharacters = 4000;

const readHeader = (lines: readonly string[]): CheckHeaderIdentity | undefined => {
  const values = headerNames.map((name, index) => {
    const pattern = new RegExp(`^${name}: ([a-f0-9]{40}|[a-f0-9]{64})$`, 'u');

    return pattern.exec(lines[index] ?? '')?.[1];
  });

  const [head, status, diff] = values;

  if (head === undefined || status === undefined || diff === undefined) {
    return undefined;
  }

  return { head, status, diff };
};

const compareIdentity = (
  recorded: CheckHeaderIdentity,
  current: CheckHeaderIdentity,
): CheckReason[] =>
  identityFields
    .filter((field) => recorded[field] !== current[field])
    .map((field) => ({
      field,
      reason: `Recorded ${field} ${recorded[field]} does not match current ${current[field]}.`,
    }));

const checkReasons = (
  recorded: CheckHeaderIdentity | undefined,
  current: CheckHeaderIdentity | null,
): CheckReason[] => {
  const reasons: CheckReason[] = [];

  if (recorded === undefined) {
    reasons.push({
      field: 'header',
      reason: 'The first three lines must be HEAD, Status, and Diff hash headers.',
    });
  }

  if (current === null) {
    reasons.push({ field: 'current', reason: 'Current check identity is unavailable.' });
  }

  if (recorded !== undefined && current !== null) {
    reasons.push(...compareIdentity(recorded, current));
  }

  return reasons;
};

export const excerptBody = (body: string[]): { excerpt: string; truncated: boolean } => {
  const tail = body.slice(-excerptLines).join('\n');
  const excerpt = tail.slice(-excerptCharacters);
  const truncated = body.length > excerptLines || tail.length > excerptCharacters;

  return { excerpt, truncated };
};

export const matchCheckLog = (
  path: string,
  text: string,
  current: CheckHeaderIdentity | null,
): CheckLog => {
  const lines = text.split('\n');
  const recorded = readHeader(lines);
  const reasons = checkReasons(recorded, current);

  if (reasons.length > 0) {
    return { path, matches: false, reasons, excerpt: null, truncated: false };
  }

  const body = lines.slice(headerNames.length);

  if (body.at(-1) === '') {
    body.pop();
  }

  return { path, matches: true, reasons: [], ...excerptBody(body) };
};

const isNewerLog = (candidate: TimedCheckLog, previous: TimedCheckLog) => {
  if (candidate.modifiedAt === previous.modifiedAt) {
    return candidate.check.path > previous.check.path;
  }

  return candidate.modifiedAt > previous.modifiedAt;
};

const hasTimestamp = (log: ModifiedCheckLog): log is TimedCheckLog => log.modifiedAt !== null;

// A log without a readable timestamp is never treated as superseded, and never supersedes another.
export const selectLatestChecks = (logs: readonly ModifiedCheckLog[]): CheckLog[] => {
  const latest = new Map<string, TimedCheckLog>();

  for (const candidate of logs.filter(hasTimestamp)) {
    const previous = latest.get(candidate.name);

    if (previous === undefined || isNewerLog(candidate, previous)) {
      latest.set(candidate.name, candidate);
    }
  }

  const untimed = logs.filter((log) => !hasTimestamp(log));

  return [...latest.values(), ...untimed]
    .map((log) => log.check)
    .toSorted((left, right) => left.path.localeCompare(right.path));
};

const hasEvidenceFailure = (check: CheckLog) =>
  check.reasons.some(
    (reason) => reason.field === 'header' || reason.field === 'read' || reason.field === 'current',
  );

const hasFullCheckLog = (fullCheck: FullCheckDecision | null): boolean =>
  fullCheck?.status === 'passed' || fullCheck?.status === 'failed';

export const checkLogGaps = (
  checks: readonly CheckLog[],
  fullCheck: FullCheckDecision | null,
): PublicationGap[] => {
  if (checks.length === 0 && hasFullCheckLog(fullCheck)) {
    return [];
  }

  if (checks.length === 0) {
    return [{ kind: 'noChecks' }];
  }

  return checks.flatMap((check): PublicationGap[] => {
    if (hasEvidenceFailure(check)) {
      return [{ kind: 'check', path: check.path, reasons: check.reasons }];
    }

    return check.truncated ? [{ kind: 'checkExcerpt', path: check.path }] : [];
  });
};

const sameState = (current: CheckState, record: CheckState): boolean =>
  record.head === current.head &&
  record.base === current.base &&
  record.fingerprint === current.fingerprint;

const matchesState = (current: CheckState, log: SavedLog): boolean =>
  log.logExists && log.read.status === 'valid' && sameState(current, log.read.record);

// Takes the newest record for the current state. argv is not compared, because the caller does not
// read the full check config.
export const decideFullCheck = (current: CheckState, saved: SavedLog[]): FullCheckDecision => {
  if (current.fingerprint === null) {
    return { status: 'missing' };
  }

  const match = saved.find((log) => matchesState(current, log));

  if (match?.read.status === 'valid') {
    const { passed, argv } = match.read.record;

    return { status: passed ? 'passed' : 'failed', logPath: match.logPath, argv };
  }

  const malformed = saved.some((log) => log.read.status === 'malformed');

  return { status: malformed ? 'malformed' : 'missing' };
};
