export interface WatchFacts {
  pullRequest: { state: string; mergedAt: string | null } | undefined;
  checks: { name: string; bucket: string }[] | undefined;
}

export type WatchOutcome =
  | { kind: 'waiting' }
  | { kind: 'merged' }
  | { kind: 'closed'; state: string }
  | { kind: 'checksFailed'; checks: string[] }
  | { kind: 'deadline' };

export type FinalOutcome = Exclude<WatchOutcome, { kind: 'waiting' }>;

type PollOutcome = Exclude<WatchOutcome, { kind: 'deadline' }>;

const failedBuckets = new Set(['fail', 'cancel']);

const failedChecks = (checks: WatchFacts['checks']): string[] =>
  (checks ?? []).filter((check) => failedBuckets.has(check.bucket)).map((check) => check.name);

export const decideWatchOutcome = (facts: WatchFacts): PollOutcome => {
  const { pullRequest } = facts;

  if (pullRequest?.mergedAt != null) {
    return { kind: 'merged' };
  }

  if (pullRequest !== undefined && pullRequest.state !== 'OPEN') {
    return { kind: 'closed', state: pullRequest.state };
  }

  const failed = pullRequest === undefined ? [] : failedChecks(facts.checks);

  if (failed.length > 0) {
    return { kind: 'checksFailed', checks: failed };
  }

  return { kind: 'waiting' };
};

export const describeWatchOutcome = (url: string, outcome: FinalOutcome): string => {
  if (outcome.kind === 'merged') {
    return `Pull request ${url} merged.`;
  }

  if (outcome.kind === 'closed') {
    return `Pull request ${url} closed without merging. Its state is ${outcome.state}.`;
  }

  if (outcome.kind === 'checksFailed') {
    return `Pull request ${url} will not auto-merge. These required checks failed: ${outcome.checks.join(', ')}.`;
  }

  return `Pull request ${url} has not merged yet. Tau stopped watching it after 2 hours.`;
};
