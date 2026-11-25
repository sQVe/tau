import type { AskKind } from '../schema.ts';

export interface ShadowQuestionFacts {
  kind?: AskKind | undefined;
  multiSelect: boolean;
  preview?: string | undefined;
  options: readonly {
    recommended?: boolean | undefined;
    preview?: string | undefined;
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
  | 'multiSelect';

export type QuestionSkipReason = Exclude<ShadowSkipReason, 'multipleQuestions'>;

type QuestionEligibility = { kind: 'eligible' } | { kind: 'skip'; reason: QuestionSkipReason };

export type ShadowEligibility<Question extends ShadowQuestionFacts> =
  | { kind: 'eligible'; question: Question }
  | { kind: 'skip'; reason: ShadowSkipReason };

export const shadowBatchIntervalMilliseconds = 60_000;

const recommendedCount = (question: ShadowQuestionFacts): number =>
  question.options.filter((option) => option.recommended === true).length;

const previewedOption = (question: ShadowQuestionFacts): boolean =>
  question.options.some((option) => option.preview !== undefined);

export const questionEligibility = (question: ShadowQuestionFacts): QuestionEligibility => {
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

  return { kind: 'eligible' };
};

export const shadowEligibility = <Question extends ShadowQuestionFacts>(
  questions: readonly Question[],
): ShadowEligibility<Question> => {
  if (questions.length !== 1) {
    return { kind: 'skip', reason: 'multipleQuestions' };
  }

  const question = questions[0];

  if (question === undefined) {
    return { kind: 'skip', reason: 'multipleQuestions' };
  }

  const eligibility = questionEligibility(question);

  if (eligibility.kind === 'skip') {
    return eligibility;
  }

  return { kind: 'eligible', question };
};

export const shadowRateAllows = (lastBatchStartedAt: number | undefined, now: number): boolean =>
  lastBatchStartedAt === undefined || now - lastBatchStartedAt >= shadowBatchIntervalMilliseconds;
