export type PullRequestEvidence = { url: string; state: string } | { url: string; error: string };

export type CancelDecision =
  | { kind: 'cancel' }
  | { kind: 'unchanged' }
  | { kind: 'refuse'; reason: string };

export const decideConfirmedCancel = (
  preview: { title: string; state: { name: string } },
  current: { title: string; state: { name: string } },
): CancelDecision => {
  if (current.title !== preview.title) {
    return { kind: 'refuse', reason: 'The ticket title changed while you answered.' };
  }

  if (current.state.name !== preview.state.name) {
    return { kind: 'refuse', reason: 'The ticket state changed while you answered.' };
  }

  return { kind: 'cancel' };
};

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
