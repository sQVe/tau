import { Type } from 'typebox';

import { checkOutput, parseRepository, readJson } from '../../github.js';
import type { Runtime } from '../../github.js';
import type { ConfigLocation, ConfigWarnings } from '../../tauConfig.js';
import { decideReviewBots } from './reviewBotDecisions.js';
import type { ReviewBotDecision } from './reviewBotDecisions.js';
import { readReviewBots } from './reviewBotSettings.js';

export interface ReviewBotsRequest {
  repository?: string;
  pr?: number;
}

export interface ReviewBotsResult {
  // Empty when the user config has no entry for the repository, so no bot is requested.
  bots: ReviewBotDecision[];
}

const pullRequestSchema = Type.Object({
  headRefOid: Type.String(),
  commits: Type.Array(Type.Object({ oid: Type.String(), committedDate: Type.String() })),
  reviews: Type.Array(
    Type.Object({
      author: Type.Union([Type.Object({ login: Type.String() }), Type.Null()]),
      commit: Type.Union([Type.Object({ oid: Type.String() }), Type.Null()]),
    }),
  ),
  comments: Type.Array(Type.Object({ body: Type.String(), createdAt: Type.String() })),
});

const requirePullRequest = (pr: number | undefined) => {
  if (pr === undefined) {
    throw new Error('reviewBots needs pr.');
  }

  if (!Number.isSafeInteger(pr) || pr < 1) {
    throw new Error(`pr must be an integer of 1 or more, not ${pr}.`);
  }

  return pr;
};

const readPublished = async (runtime: Runtime, repository: string, pr: number) => {
  const commandArguments = [
    'pr',
    'view',
    String(pr),
    '--repo',
    repository,
    '--json',
    'headRefOid,commits,reviews,comments',
  ];

  const view = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, pullRequestSchema, view);

  return view;
};

// Reads the configured review bots of the base repository and what each did on the pull request's
// head. It never posts. The head commit's committer date marks when a request counts for the head,
// since gh does not report when the head was pushed.
export const readReviewBotStatuses = async (
  runtime: Runtime,
  location: ConfigLocation,
  ui: ConfigWarnings,
  request: ReviewBotsRequest,
): Promise<ReviewBotsResult> => {
  if (request.repository === undefined) {
    throw new Error('reviewBots needs repository.');
  }

  const repository = parseRepository(request.repository);
  const pr = requirePullRequest(request.pr);
  const bots = readReviewBots(location, ui, `${repository.owner}/${repository.name}`);

  if (bots === undefined || bots.length === 0) {
    return { bots: [] };
  }

  const view = await readPublished(runtime, request.repository, pr);
  const headCommit = view.commits.find((commit) => commit.oid === view.headRefOid);

  if (headCommit === undefined) {
    throw new Error(
      `gh pr view ${pr} did not list the head commit ${view.headRefOid}, so reviewBots cannot date the head.`,
    );
  }

  const decisions = decideReviewBots({
    bots,
    head: view.headRefOid,
    headCommittedAt: headCommit.committedDate,
    reviews: view.reviews.map((review) => ({
      login: review.author?.login ?? '',
      commit: review.commit?.oid,
    })),
    comments: view.comments,
  });

  return { bots: decisions };
};
