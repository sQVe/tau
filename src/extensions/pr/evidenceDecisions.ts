import type { ReviewEvidence } from '../../reviewCapture/evidence.js';

export interface CheckIdentity {
  head: string;
  status: string;
  diff: string;
}

interface CheckReason {
  field: keyof CheckIdentity | 'header' | 'read' | 'current';
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

export type PublicationGap =
  | { kind: 'noReview' | 'noChecks' }
  | { kind: 'target' | 'branch' | 'subjects' | 'reuse' | 'review' | 'checks'; reason: string }
  | { kind: 'reuseMismatch'; reasons: string[] }
  | { kind: 'reviewEvidence'; gap: ReviewEvidence['gaps'][number] }
  | { kind: 'check'; path: string; reasons: CheckReason[] }
  | { kind: 'checkExcerpt'; path: string };

const identityFields = ['head', 'status', 'diff'] as const;
const headerNames = ['HEAD', 'Status', 'Diff'] as const;
const excerptLines = 20;
const excerptCharacters = 4000;

const readHeader = (lines: readonly string[]): CheckIdentity | undefined => {
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

const compareIdentity = (recorded: CheckIdentity, current: CheckIdentity): CheckReason[] =>
  identityFields
    .filter((field) => recorded[field] !== current[field])
    .map((field) => ({
      field,
      reason: `Recorded ${field} ${recorded[field]} does not match current ${current[field]}.`,
    }));

const checkReasons = (
  recorded: CheckIdentity | undefined,
  current: CheckIdentity | null,
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

export const matchCheckLog = (
  path: string,
  text: string,
  current: CheckIdentity | null,
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

  const tail = body.slice(-excerptLines).join('\n');
  const excerpt = tail.slice(-excerptCharacters);
  const truncated = body.length > excerptLines || tail.length > excerptCharacters;

  return { path, matches: true, reasons: [], excerpt, truncated };
};

const isNewerLog = (candidate: ModifiedCheckLog, previous: ModifiedCheckLog) => {
  if (candidate.modifiedAt === previous.modifiedAt) {
    return candidate.check.path > previous.check.path;
  }

  // An unreadable timestamp cannot establish that this evidence was superseded.
  if (candidate.modifiedAt === null) {
    return true;
  }

  if (previous.modifiedAt === null) {
    return false;
  }

  return candidate.modifiedAt > previous.modifiedAt;
};

export const selectLatestChecks = (logs: readonly ModifiedCheckLog[]): CheckLog[] => {
  const latest = new Map<string, ModifiedCheckLog>();

  for (const candidate of logs) {
    const previous = latest.get(candidate.name);

    if (previous === undefined || isNewerLog(candidate, previous)) {
      latest.set(candidate.name, candidate);
    }
  }

  return [...latest.values()]
    .map((log) => log.check)
    .toSorted((left, right) => left.path.localeCompare(right.path));
};

const hasEvidenceFailure = (check: CheckLog) =>
  check.reasons.some(
    (reason) => reason.field === 'header' || reason.field === 'read' || reason.field === 'current',
  );

export const checkLogGaps = (checks: readonly CheckLog[]): PublicationGap[] => {
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
