import { Type } from 'typebox';

import { checkOutput, parseRepository, label, readJson, run } from '../../github.js';
import type { Repository, Runtime } from '../../github.js';
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
    'headRefOid,reviews,comments',
  ];

  const view = await readJson(runtime, commandArguments);

  checkOutput(commandArguments, pullRequestSchema, view);

  return view;
};

const readHeadDate = async (runtime: Runtime, repository: Repository, head: string) => {
  const commandArguments = [
    'api',
    '--hostname',
    repository.host,
    `repos/${repository.owner}/${repository.name}/commits/${head}`,
    '--jq',
    '.commit.committer.date',
  ];

  const stdout = await run(runtime, commandArguments);
  const date = stdout.trim();

  if (!date) {
    throw new Error(`${label(commandArguments)} printed no committer date.`);
  }

  return date;
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
  const headCommittedAt = await readHeadDate(runtime, repository, view.headRefOid);

  const decisions = decideReviewBots({
    bots,
    head: view.headRefOid,
    headCommittedAt,
    reviews: view.reviews.map((review) => ({
      login: review.author?.login ?? '',
      commit: review.commit?.oid,
    })),
    comments: view.comments,
  });

  return { bots: decisions };
};
