import type { JsonObject } from '@earendil-works/pi-ai';

import type {
  ClassifyQuestion,
  JudgeOption,
  JudgeQuestion,
  JudgeVerdict,
  PastAnswer,
} from './questionGate.ts';

export interface JudgeOptionView extends JsonObject {
  label: string;
  description: string;
}

export interface QuestionExample extends JsonObject {
  question: string;
  options: JudgeOptionView[];
  recommended: string;
  answer: string;
}

const typedAnswerLimit = 300;

const answerText = (answer: PastAnswer['outcome']): string => {
  if (answer.kind === 'recommended') {
    return 'recommended';
  }

  if (answer.kind === 'otherOption') {
    return `other option: ${answer.label}`;
  }

  return `typed: ${answer.text.slice(0, typedAnswerLimit)}`;
};

export const questionOptions = (question: JudgeQuestion): JudgeOptionView[] =>
  question.options.map((option) => ({ label: option.label, description: option.description }));

export const recommendedLabel = (options: readonly JudgeOption[]): string =>
  options.find((option) => option.recommended)?.label ?? '';

export const questionExamples = (examples: readonly PastAnswer[]): QuestionExample[] =>
  examples.map((past) => ({
    question: past.question.question,
    options: questionOptions(past.question),
    recommended: recommendedLabel(past.question.options),
    answer: answerText(past.outcome),
  }));

export const judgeWithClassifier = async (
  classify: ClassifyQuestion,
  question: JudgeQuestion,
  examples: readonly PastAnswer[],
  signal: AbortSignal | undefined,
): Promise<JudgeVerdict> => {
  const state: JsonObject = {
    question: question.question,
    problem: question.problem,
    impact: question.impact,
    options: questionOptions(question),
    recommended: recommendedLabel(question.options),
  };

  if (examples.length > 0) {
    state.examples = questionExamples(examples);
  }

  const outcome = await classify(
    state,
    {
      instructions: 'Will the user pick the recommended option as it is, without changes?',
      criteria: {
        accept: 'The user picks the recommended option as it is.',
        other: 'The user picks another option or types their own answer.',
      },
    },
    signal,
  );

  if (outcome.kind !== 'answered') {
    return outcome;
  }

  if (outcome.label === 'accept') {
    return { kind: 'answered', confidence: outcome.confidence };
  }

  if (outcome.label === 'other') {
    return { kind: 'answered', confidence: 1 - outcome.confidence };
  }

  return { kind: 'error' };
};
