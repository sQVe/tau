export interface StatusFacts {
  pr: number;
  url: string;
  expectedHead: string;
  head: string;
  headMoved: boolean;
  draft: boolean;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  unresolvedThreads: number;
  checks: { name: string; bucket: string }[];
  reviews: { id: number; login: string | null; state: string }[];
  bots: { login: string; status: string }[];
  gaps: string[];
}

interface StatusReason {
  code: string;
  count?: number;
  names?: string[];
  logins?: (string | null)[];
}

type Verdict = 'action-required' | 'waiting-checks' | 'waiting-human' | 'clear' | 'unknown';

export interface StatusResult {
  pr: number;
  url: string;
  head: string;
  draft: boolean;
  state: string;
  mergeable: string;
  mergeStateStatus: string;
  verdict: Verdict;
  reasons: StatusReason[];
  gaps: string[];
}

const requestedChanges = (reviews: StatusFacts['reviews']) => {
  const latest = new Map<string | number, StatusFacts['reviews'][number]>();

  for (const review of reviews.toSorted((left, right) => left.id - right.id)) {
    if (review.state === 'COMMENTED' || review.state === 'PENDING') {
      continue;
    }

    const key = review.login?.toLowerCase() ?? review.id;

    latest.set(key, review);
  }

  return [...latest.values()]
    .filter((review) => review.state === 'CHANGES_REQUESTED')
    .map((review) => review.login);
};

const actionReasons = (facts: StatusFacts): StatusReason[] => {
  const reasons: StatusReason[] = [];

  if (facts.mergeable === 'CONFLICTING' || facts.mergeStateStatus === 'DIRTY') {
    reasons.push({ code: 'conflict' });
  }

  if (facts.mergeStateStatus === 'BEHIND') {
    reasons.push({ code: 'behind' });
  }

  if (facts.unresolvedThreads > 0) {
    reasons.push({ code: 'unresolvedThreads', count: facts.unresolvedThreads });
  }

  const failing = facts.checks.filter(
    (check) => check.bucket === 'fail' || check.bucket === 'cancel',
  );

  if (failing.length > 0) {
    reasons.push({ code: 'failingChecks', names: failing.map((check) => check.name) });
  }

  const logins = requestedChanges(facts.reviews);

  if (facts.reviewDecision === 'CHANGES_REQUESTED' || logins.length > 0) {
    reasons.push({ code: 'changesRequested', logins });
  }

  return reasons;
};

const waitingReasons = (facts: StatusFacts) => {
  const checks: StatusReason[] = [];
  const human: StatusReason[] = [];
  const pending = facts.checks.filter((check) => check.bucket === 'pending');
  const bots = facts.bots.filter((bot) => bot.status === 'requested');

  if (pending.length > 0) {
    checks.push({ code: 'pendingChecks', names: pending.map((check) => check.name) });
  }

  if (bots.length > 0) {
    checks.push({ code: 'botReviewPending', logins: bots.map((bot) => bot.login) });
  }

  if (facts.reviewDecision === 'REVIEW_REQUIRED') {
    human.push({ code: 'approvalRequired' });
  }

  if (facts.draft) {
    human.push({ code: 'draft' });
  }

  return { checks, human };
};

const unknownReasons = (facts: StatusFacts, knownGate: boolean): StatusReason[] => {
  const reasons: StatusReason[] = [];

  if (facts.gaps.length > 0) {
    reasons.push({ code: 'readGap' });
  }

  if (facts.mergeable === 'UNKNOWN') {
    reasons.push({ code: 'mergeabilityUnknown' });
  }

  if (facts.mergeStateStatus === 'BLOCKED' && !knownGate) {
    reasons.push({ code: 'blockedUnknown' });
  }

  return reasons;
};

const verdictFor = (
  action: boolean,
  unknown: boolean,
  checks: boolean,
  human: boolean,
): Verdict => {
  if (action) {
    return 'action-required';
  }

  if (unknown) {
    return 'unknown';
  }

  if (checks) {
    return 'waiting-checks';
  }

  return human ? 'waiting-human' : 'clear';
};

export const decideStatus = (facts: StatusFacts): StatusResult => {
  const { pr, url, head, draft, state, mergeable, mergeStateStatus, gaps } = facts;
  const metadata = { pr, url, head, draft, state, mergeable, mergeStateStatus, gaps };

  if (state === 'MERGED') {
    return { ...metadata, verdict: 'clear', reasons: [{ code: 'merged' }] };
  }

  if (state === 'CLOSED') {
    return { ...metadata, verdict: 'unknown', reasons: [{ code: 'closed' }] };
  }

  if (head !== facts.expectedHead || facts.headMoved) {
    return { ...metadata, verdict: 'unknown', reasons: [{ code: 'headMoved' }] };
  }

  const action = actionReasons(facts);
  const waiting = waitingReasons(facts);
  const reasons = [...action, ...waiting.checks, ...waiting.human];
  const unknown = unknownReasons(facts, reasons.length > 0);

  const verdict = verdictFor(
    action.length > 0,
    unknown.length > 0,
    waiting.checks.length > 0,
    waiting.human.length > 0,
  );

  return { ...metadata, verdict, reasons: [...reasons, ...unknown] };
};

export const recommendStatus = (
  results: StatusResult[],
): { recommended: number | null; reason: string | null; attention: number[] } => {
  const action = results.find((result) => result.verdict === 'action-required');
  const unknown = results.find((result) => result.verdict === 'unknown');
  const recommended = (action ?? unknown)?.pr ?? null;

  const attention = results
    .filter((result) => result.verdict === 'action-required' || result.verdict === 'unknown')
    .map((result) => result.pr);

  const reason =
    recommended === null
      ? null
      : `Start with PR #${recommended}: a fix there changes the PRs above it. The user still picks.`;

  return { recommended, reason, attention };
};
