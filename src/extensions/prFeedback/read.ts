import { createHash } from 'node:crypto';

import type { CommandRuntime } from '../../command.js';
import { checkAuth, readViewer } from '../../github/github.js';
import type { Repository } from '../../github/github.js';
import { formatRepository } from '../../github/repositoryTargetDecisions.js';
import {
  HeadMovedError,
  readIssueComments,
  readPullRequest,
  readReviews,
  readThreads,
} from './github.js';
import type { PullRequest } from './github.js';
import { snapshotChange } from './snapshotChange.js';
import type { PullRequestSnapshot } from './snapshotChange.js';
import {
  conversationComments,
  rejectLongThreads,
  reviewsWithBody,
  stateText,
  unresolvedThreads,
} from './threads.js';
import type { Comment, Review, Thread } from './threads.js';

export interface PullRequestFeedback {
  viewer: string;
  pr: {
    number: number;
    url: string;
    author: string;
    headRefOid: string;
    state: string;
    baseRefName: string;
    headRefName: string;
    headRepository: string | null;
    headRepositoryOwner: string;
    isCrossRepository: boolean;
    maintainerCanModify: boolean;
    mergeable: string;
  };
  threads: Thread[];
  reviews: Review[];
  comments: Comment[];
  stateToken: string;
}

const mergeableRereads = 3;

const requireOpen = (pullRequest: PullRequest) => {
  if (pullRequest.state !== 'OPEN') {
    throw new Error(`Pull request ${pullRequest.url} is ${pullRequest.state}, not OPEN.`);
  }
};

const pullRequestFields = (pullRequest: PullRequest): PullRequestSnapshot => ({
  number: pullRequest.number,
  url: pullRequest.url,
  author: pullRequest.author.login,
  headRefOid: pullRequest.headRefOid,
  state: pullRequest.state,
  baseRefName: pullRequest.baseRefName,
  headRefName: pullRequest.headRefName,
  headRepository: pullRequest.headRepository?.name ?? null,
  headRepositoryOwner: pullRequest.headRepositoryOwner.login,
  isCrossRepository: pullRequest.isCrossRepository,
  maintainerCanModify: pullRequest.maintainerCanModify,
});

const requireUnchanged = (first: PullRequest, current: PullRequest) => {
  const change = snapshotChange(pullRequestFields(first), pullRequestFields(current));

  if (change?.field === 'headRefOid') {
    const error = new HeadMovedError(current.headRefOid, first.headRefOid);

    error.message = `The pull request headRefOid changed from ${first.headRefOid} to ${current.headRefOid} during the read. Read again.`;

    throw error;
  }

  if (change !== undefined) {
    throw new Error(
      `The pull request ${change.field} changed from ${String(change.before)} to ${String(change.after)} during the read. Read again.`,
    );
  }
};

export const settleMergeable = async (
  runtime: CommandRuntime,
  repository: Repository,
  pullRequest: PullRequest,
): Promise<string> => {
  let { mergeable } = pullRequest;

  for (let reread = 0; reread < mergeableRereads && mergeable === 'UNKNOWN'; reread += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each read waits for GitHub to settle mergeable.
    const current = await readPullRequest(runtime, repository, pullRequest.number);

    requireOpen(current);
    requireUnchanged(pullRequest, current);

    ({ mergeable } = current);
  }

  return mergeable;
};

export const readFeedback = async (
  runtime: CommandRuntime,
  repository: Repository,
  pr: number,
): Promise<PullRequestFeedback> => {
  await checkAuth(runtime, repository.host);

  const [viewer, pullRequest, threadNodes, reviewItems, commentItems] = await Promise.all([
    readViewer(runtime, repository),
    readPullRequest(runtime, repository, pr),
    readThreads(runtime, repository, pr),
    readReviews(runtime, repository, pr),
    readIssueComments(runtime, repository, pr),
  ]);

  requireOpen(pullRequest);

  rejectLongThreads(threadNodes);

  const mergeable = await settleMergeable(runtime, repository, pullRequest);

  const feedback = { viewer, threads: threadNodes, reviews: reviewItems, comments: commentItems };

  const name = formatRepository(repository);
  const text = stateText(`${name}#${pr}`, feedback);
  const token = createHash('sha256').update(text).digest('hex');

  return {
    viewer,
    pr: { ...pullRequestFields(pullRequest), mergeable },
    threads: unresolvedThreads(feedback),
    reviews: reviewsWithBody(feedback),
    comments: conversationComments(feedback),
    stateToken: token,
  };
};
