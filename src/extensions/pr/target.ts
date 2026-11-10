import type { CommandRuntime } from '../../command.js';
import { readGit } from '../../git.js';
import { checkAuth, pickPullRequests, readPullRequestList } from '../../github/github.js';
import type { PullRequest } from '../../github/github.js';
import { resolveBaseRepository, resolveHead } from '../../github/repositoryTarget.js';
import { formatRepository } from '../../github/repositoryTargetDecisions.js';
import { pickBaseBranch, pickBaseRemote, rejectDefaultBranch } from './targetDecisions.js';

export interface TargetRequest {
  remote: string | undefined;
  base: string | undefined;
}

export interface Target {
  host: string;
  repository: string;
  head: { remote: string; repository: string; owner: string; branch: string; sha: string };
  base: { remote: string; branch: string };
  mergeBase: string;
  pr: PullRequest | null;
  closedPrs: PullRequest[];
}

// Fetches into the tracking ref itself, since the remote's fetch refspec may leave the base out.
const pinMergeBase = async (cwd: string, remote: string, branch: string) => {
  const trackingRef = `refs/remotes/${remote}/${branch}`;

  await readGit(cwd, ['fetch', '--quiet', remote, `+refs/heads/${branch}:${trackingRef}`]);

  return readGit(cwd, ['merge-base', trackingRef, 'HEAD']);
};

export const readTarget = async (
  runtime: CommandRuntime,
  request: TargetRequest,
): Promise<Target> => {
  const { cwd } = runtime;
  const head = await resolveHead(runtime, request);
  const { host } = head.repository;

  await checkAuth(runtime, host);

  const base = await resolveBaseRepository(runtime, head.repository);

  rejectDefaultBranch({
    localBranch: head.localBranch,
    pushBranch: head.branch,
    headRepository: head.repository,
    defaultBranch: base.headDefaultBranch,
  });

  const baseRemote = pickBaseRemote(head.remotes, head.remote, base.repository);
  const listed = await readPullRequestList(runtime, base.repository, head.branch);
  const { pr, closedPrs } = pickPullRequests(listed, head.repository);

  const baseBranch = pickBaseBranch({
    pr,
    requestedBase: request.base,
    defaultBranch: base.defaultBranch,
  });

  return {
    host,
    repository: formatRepository(base.repository),
    head: {
      remote: head.remote,
      repository: formatRepository(head.repository),
      owner: head.repository.owner,
      branch: head.branch,
      sha: await readGit(cwd, ['rev-parse', 'HEAD']),
    },
    base: { remote: baseRemote, branch: baseBranch },
    mergeBase: await pinMergeBase(cwd, baseRemote, baseBranch),
    pr,
    closedPrs,
  };
};
