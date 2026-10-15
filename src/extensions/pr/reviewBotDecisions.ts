import type { ReviewBot } from './reviewBotSettings.js';

export type ReviewBotStatus = 'request' | 'reviewed' | 'requested';

export interface ReviewBotFacts {
  bots: ReviewBot[];
  headCommittedAt: string;
  // When GitHub created the earliest check suite of the head, if it created any.
  headCheckSuiteAt?: string | undefined;
  reviews: { login: string; commit: string | undefined }[];
  comments: { body: string; createdAt: string }[];
  head: string;
}

export interface ReviewBotDecision extends ReviewBot {
  status: ReviewBotStatus;
}

// gh prints a bot's login without the `[bot]` suffix that the GitHub UI shows.
export const normalizeLogin = (login: string): string =>
  login.toLowerCase().replace(/\[bot\]$/u, '');

const sameLogin = (first: string, second: string) =>
  normalizeLogin(first) === normalizeLogin(second);

// A comment from before the head reached GitHub asked for a review of older code. GitHub reports
// no push time, so the head counts from the later of its committer date and its earliest check
// suite, which GitHub creates on push. A repository with no check apps has no suite, and a request
// made after the commit but before the push then still counts for the head.
const requestedForHead = (facts: ReviewBotFacts, bot: ReviewBot) => {
  const committedTime = Date.parse(facts.headCommittedAt);

  const suiteTime =
    facts.headCheckSuiteAt === undefined ? committedTime : Date.parse(facts.headCheckSuiteAt);

  const headTime = Math.max(committedTime, suiteTime);

  return facts.comments.some(
    (comment) => comment.body === bot.comment && Date.parse(comment.createdAt) >= headTime,
  );
};

const reviewedHead = (facts: ReviewBotFacts, bot: ReviewBot) =>
  facts.reviews.some(
    (review) => sameLogin(review.login, bot.login) && review.commit === facts.head,
  );

const decide = (facts: ReviewBotFacts, bot: ReviewBot): ReviewBotStatus => {
  if (reviewedHead(facts, bot)) {
    return 'reviewed';
  }

  return requestedForHead(facts, bot) ? 'requested' : 'request';
};

export const decideReviewBots = (facts: ReviewBotFacts): ReviewBotDecision[] =>
  facts.bots.map((bot) => ({ ...bot, status: decide(facts, bot) }));
