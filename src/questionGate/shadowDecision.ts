export interface ShadowQuestionFacts {
  kind: 'choice' | 'approval' | undefined;
  multiSelect: boolean;
  preview: string | undefined;
  options: readonly {
    recommended: boolean;
    preview: string | undefined;
  }[];
}

export type ShadowSkipReason =
  | 'multipleQuestions'
  | 'kindMissing'
  | 'kindApproval'
  | 'noRecommendation'
  | 'manyRecommendations'
  | 'questionPreview'
  | 'optionPreview'
  | 'multiSelect'
  | 'recentBatch';

export type ShadowDecision = { kind: 'sample' } | { kind: 'skip'; reason: ShadowSkipReason };

export interface ShadowDecisionFacts {
  questions: readonly ShadowQuestionFacts[];
  lastBatchStartedAt: number | undefined;
  now: number;
}

export const shadowBatchIntervalMilliseconds = 60_000;

const recommendedCount = (question: ShadowQuestionFacts): number =>
  question.options.filter((option) => option.recommended).length;

const previewedOption = (question: ShadowQuestionFacts): boolean =>
  question.options.some((option) => option.preview !== undefined);

export const shadowEligibility = (questions: readonly ShadowQuestionFacts[]): ShadowDecision => {
  if (questions.length !== 1) {
    return { kind: 'skip', reason: 'multipleQuestions' };
  }

  const question = questions[0];

  if (question === undefined) {
    return { kind: 'skip', reason: 'multipleQuestions' };
  }

  if (question.kind === undefined) {
    return { kind: 'skip', reason: 'kindMissing' };
  }

  if (question.kind !== 'choice') {
    return { kind: 'skip', reason: 'kindApproval' };
  }

  const recommended = recommendedCount(question);

  if (recommended === 0) {
    return { kind: 'skip', reason: 'noRecommendation' };
  }

  if (recommended > 1) {
    return { kind: 'skip', reason: 'manyRecommendations' };
  }

  if (question.preview !== undefined) {
    return { kind: 'skip', reason: 'questionPreview' };
  }

  if (previewedOption(question)) {
    return { kind: 'skip', reason: 'optionPreview' };
  }

  if (question.multiSelect) {
    return { kind: 'skip', reason: 'multiSelect' };
  }

  return { kind: 'sample' };
};

export const shadowDecision = (facts: ShadowDecisionFacts): ShadowDecision => {
  const eligibility = shadowEligibility(facts.questions);

  if (eligibility.kind === 'skip') {
    return eligibility;
  }

  const { lastBatchStartedAt, now } = facts;

  if (
    lastBatchStartedAt !== undefined &&
    now - lastBatchStartedAt < shadowBatchIntervalMilliseconds
  ) {
    return { kind: 'skip', reason: 'recentBatch' };
  }

  return { kind: 'sample' };
};
