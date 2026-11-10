export type PullRequestEvidence = { url: string; state: string } | { url: string; error: string };

export type CancelDecision =
  | { kind: 'cancel' }
  | { kind: 'unchanged' }
  | { kind: 'refuse'; reason: string };

export const decideCancel = (
  state: string,
  pullRequests: readonly PullRequestEvidence[],
): CancelDecision => {
  if (state === 'canceled') {
    return { kind: 'unchanged' };
  }

  if (state === 'completed') {
    return { kind: 'refuse', reason: 'The ticket is completed.' };
  }

  for (const pullRequest of pullRequests) {
    if ('error' in pullRequest) {
      return { kind: 'refuse', reason: `Cannot read ${pullRequest.url}: ${pullRequest.error}` };
    }

    if (pullRequest.state === 'MERGED') {
      return { kind: 'refuse', reason: `The pull request ${pullRequest.url} is merged.` };
    }
  }

  return { kind: 'cancel' };
};
