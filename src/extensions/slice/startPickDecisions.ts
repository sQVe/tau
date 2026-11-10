export interface PickPullRequest {
  url: string;
  state: string;
}

interface PickBlocker {
  identifier: string;
  pullRequests: PickPullRequest[];
}

export interface PickSlice {
  identifier: string;
  title: string;
  url: string;
  branchName: string;
  team: { id: string; key: string };
  description: string;
  completed: boolean;
  canceled: boolean;
  pullRequests: PickPullRequest[];
  blockers: PickBlocker[];
}

export interface StartPick {
  chosen:
    | (Omit<PickSlice, 'completed' | 'canceled' | 'blockers' | 'pullRequests'> & {
        pullRequests: string[];
      })
    | null;
  reason: string;
  slices: {
    identifier: string;
    status: 'merged' | 'canceled' | 'completedWithoutMergedPr' | 'blocked' | 'ready';
    blockers: { identifier: string; state: 'merged' | 'open' | 'other'; pullRequests: string[] }[];
  }[];
  openBlockerPullRequests: string[];
  base: string | null;
  defaultBranch: string;
}

const blockerState = (blocker: PickBlocker): 'merged' | 'open' | 'other' => {
  if (blocker.pullRequests.some((request) => request.state === 'MERGED')) {
    return 'merged';
  }

  if (blocker.pullRequests.some((request) => request.state === 'OPEN')) {
    return 'open';
  }

  return 'other';
};

const sliceStatus = (slice: PickSlice): StartPick['slices'][number]['status'] => {
  if (slice.pullRequests.some((request) => request.state === 'MERGED')) {
    return 'merged';
  }

  if (slice.canceled) {
    return 'canceled';
  }

  if (slice.completed) {
    return 'completedWithoutMergedPr';
  }

  if (slice.blockers.some((blocker) => blockerState(blocker) === 'other')) {
    return 'blocked';
  }

  return 'ready';
};

export const decidePick = (facts: {
  slices: PickSlice[];
  container: boolean;
  defaultBranch: string;
}): StartPick => {
  const slices = facts.slices.map((slice) => ({
    identifier: slice.identifier,
    status: sliceStatus(slice),
    blockers: slice.blockers.map((blocker) => ({
      identifier: blocker.identifier,
      state: blockerState(blocker),
      pullRequests: blocker.pullRequests.map((request) => request.url),
    })),
  }));

  const ready = facts.slices.find((slice) => sliceStatus(slice) === 'ready');

  const openBlockerPullRequests =
    ready?.blockers
      .filter((blocker) => blockerState(blocker) === 'open')
      .flatMap((blocker) =>
        blocker.pullRequests
          .filter((request) => request.state === 'OPEN')
          .map((request) => request.url),
      ) ?? [];

  const chosen =
    ready === undefined
      ? null
      : {
          identifier: ready.identifier,
          title: ready.title,
          url: ready.url,
          branchName: ready.branchName,
          team: ready.team,
          description: ready.description,
          pullRequests: ready.pullRequests.map((request) => request.url),
        };

  let reason = 'No ready slice.';

  if (chosen !== null) {
    reason = facts.container ? 'First ready slice in sub-issue order.' : 'Named slice is ready.';
  }

  const base = openBlockerPullRequests.length === 0 ? `origin/${facts.defaultBranch}` : null;

  return {
    chosen,
    reason,
    slices,
    openBlockerPullRequests,
    base,
    defaultBranch: facts.defaultBranch,
  };
};
