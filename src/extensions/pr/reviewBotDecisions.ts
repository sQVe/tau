import type { ReviewBot } from './reviewBotSettings.js';

export type ReviewBotStatus = 'request' | 'reviewed' | 'requested';

export interface ReviewBotFacts {
  bots: ReviewBot[];
  headCommittedAt: string;
  reviews: { login: string; commit: string | undefined }[];
  comments: { body: string; createdAt: string }[];
  head: string;
}

export interface ReviewBotDecision extends ReviewBot {
  status: ReviewBotStatus;
}

const sameLogin = (first: string, second: string) => first.toLowerCase() === second.toLowerCase();

// A comment from before the head commit was made asked for a review of older code.
const requestedForHead = (facts: ReviewBotFacts, bot: ReviewBot) => {
  const headTime = Date.parse(facts.headCommittedAt);

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
