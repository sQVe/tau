import type { Exec } from '../../command.js';
import { runCommand } from '../../command.js';
import { errorMessage } from '../../errors.js';
import {
  capProjectRoots,
  capPullRequests,
  decideCoverage,
  inlineCommentArguments,
  parseInlineComments,
  parseReverts,
  parseReviewView,
  pullRequestViewArguments,
  revertLogArguments,
} from '../../improvement/historyRead.js';
import type {
  HistoryComment,
  HistoryGap,
  HistoryResult,
  HistoryReview,
  HistoryRevert,
} from '../../improvement/historyRead.js';
import type { RecordRequest } from './recordRequest.js';

type HistoryRequest = Extract<RecordRequest, { action: 'history' }>;

interface HistoryRuntime {
  exec: Exec;
  cwd: string;
  signal?: AbortSignal | undefined;
}

interface PullRequestRead {
  reviews: HistoryReview[];
  comments: HistoryComment[];
  gaps: HistoryGap[];
  read: boolean;
}

const readPullRequestView = async (
  runtime: HistoryRuntime,
  url: string,
): Promise<Pick<PullRequestRead, 'reviews' | 'comments' | 'gaps' | 'read'>> => {
  try {
    const stdout = await runCommand(
      runtime,
      'gh',
      pullRequestViewArguments(url),
      `gh pr view ${url}`,
    );

    const parsed = parseReviewView(url, stdout);

    return { ...parsed, read: true };
  } catch (error) {
    return {
      reviews: [],
      comments: [],
      gaps: [{ source: url, reason: errorMessage(error) }],
      read: false,
    };
  }
};

const readInlineComments = async (
  runtime: HistoryRuntime,
  url: string,
): Promise<Pick<PullRequestRead, 'comments' | 'gaps' | 'read'>> => {
  try {
    const stdout = await runCommand(
      runtime,
      'gh',
      inlineCommentArguments(url),
      `gh api inline comments for ${url}`,
    );

    const parsed = parseInlineComments(url, stdout);

    return { ...parsed, read: true };
  } catch (error) {
    return {
      comments: [],
      gaps: [{ source: url, reason: errorMessage(error) }],
      read: false,
    };
  }
};

const readPullRequest = async (runtime: HistoryRuntime, url: string): Promise<PullRequestRead> => {
  const view = await readPullRequestView(runtime, url);
  const inline = await readInlineComments(runtime, url);

  return {
    reviews: view.reviews,
    comments: [...view.comments, ...inline.comments],
    gaps: [...view.gaps, ...inline.gaps],
    read: view.read || inline.read,
  };
};

const readReverts = async (
  runtime: HistoryRuntime,
  projectRoot: string,
): Promise<{ reverts: HistoryRevert[]; gap: HistoryGap | undefined }> => {
  try {
    const stdout = await runCommand(
      runtime,
      'git',
      revertLogArguments(projectRoot),
      `git log in ${projectRoot}`,
    );

    return { reverts: parseReverts(projectRoot, stdout), gap: undefined };
  } catch (error) {
    return { reverts: [], gap: { source: projectRoot, reason: errorMessage(error) } };
  }
};

export const runHistory = async (
  runtime: HistoryRuntime,
  request: HistoryRequest,
): Promise<HistoryResult> => {
  const roots = capProjectRoots(request.projectRoots);
  const pullRequests = capPullRequests(request.pullRequests);
  const gaps: HistoryGap[] = [];
  const reverts: HistoryRevert[] = [];
  const reviews: HistoryReview[] = [];
  const comments: HistoryComment[] = [];
  let readSources = 0;

  if (roots.gap !== undefined) {
    gaps.push(roots.gap);
  }

  if (pullRequests.gap !== undefined) {
    gaps.push(pullRequests.gap);
  }

  const revertReads = await Promise.all(
    roots.entries.map((projectRoot) => readReverts(runtime, projectRoot)),
  );

  for (const read of revertReads) {
    reverts.push(...read.reverts);

    if (read.gap === undefined) {
      readSources += 1;
    } else {
      gaps.push(read.gap);
    }
  }

  const pullRequestReads = await Promise.all(
    pullRequests.entries.map((url) => readPullRequest(runtime, url)),
  );

  for (const read of pullRequestReads) {
    reviews.push(...read.reviews);
    comments.push(...read.comments);
    gaps.push(...read.gaps);

    if (read.read) {
      readSources += 1;
    }
  }

  return { reverts, reviews, comments, coverage: decideCoverage(readSources, gaps), gaps };
};
