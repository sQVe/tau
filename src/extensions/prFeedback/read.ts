import { createHash } from 'node:crypto';

import {
  readIssueComments,
  readPullRequest,
  readReviews,
  readThreads,
  readViewer,
} from './github.js';
import type { Repository, Runtime } from './github.js';
import {
  conversationComments,
  rejectLongThreads,
  reviewsWithBody,
  stateEntries,
  unresolvedThreads,
} from './threads.js';
import type { Comment, Review, Thread } from './threads.js';

export interface PullRequestFeedback {
  viewer: string;
  pr: { number: number; url: string; author: string; headRefOid: string };
  threads: Thread[];
  reviews: Review[];
  comments: Comment[];
  stateToken: string;
}

// Reads the pull request and its feedback once. Writes nothing.
export const readFeedback = async (
  runtime: Runtime,
  repository: Repository,
  pr: number,
): Promise<PullRequestFeedback> => {
  const [viewer, pullRequest, threadNodes, reviewItems, commentItems] = await Promise.all([
    readViewer(runtime, repository),
    readPullRequest(runtime, repository, pr),
    readThreads(runtime, repository, pr),
    readReviews(runtime, repository, pr),
    readIssueComments(runtime, repository, pr),
  ]);

  if (pullRequest.state !== 'OPEN') {
    throw new Error(`Pull request ${pullRequest.url} is ${pullRequest.state}, not OPEN.`);
  }

  rejectLongThreads(threadNodes);

  const feedback = { viewer, threads: threadNodes, reviews: reviewItems, comments: commentItems };

  const stateToken = createHash('sha256')
    .update(JSON.stringify(stateEntries(feedback)))
    .digest('hex');

  return {
    viewer,
    pr: {
      number: pullRequest.number,
      url: pullRequest.url,
      author: pullRequest.author.login,
      headRefOid: pullRequest.headRefOid,
    },
    threads: unresolvedThreads(feedback),
    reviews: reviewsWithBody(feedback),
    comments: conversationComments(feedback),
    stateToken,
  };
};
