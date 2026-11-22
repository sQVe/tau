import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

import { classifyChoice } from '../../classifier/classifier.js';
import { parseModelReference } from '../../config/models.js';
import type {
  QuestionGateConfig,
  QuestionGateModels,
  ShadowConfig,
} from '../../config/questionGateModels.js';
import {
  judgeWithClassifier,
  judgeWithPanel,
  panelMember,
} from '../../questionGate/questionGate.js';
import type {
  ClassifyQuestion,
  JudgeQuestion,
  JudgeVerdict,
  PanelMember,
  ShadowVariant,
} from '../../questionGate/questionGate.js';
import type { DialogQuestion } from './dialog.js';

export interface PreparedJudges {
  judge: (
    variant: ShadowVariant,
    question: JudgeQuestion,
    confidence: number | undefined,
    signal: AbortSignal,
  ) => Promise<JudgeVerdict>;
}

export const judgeQuestionOf = (
  question: DialogQuestion & { confidence?: number | undefined },
): JudgeQuestion => ({
  question: question.question,
  problem: question.problem,
  impact: question.impact,
  options: question.options.map((option) => ({
    label: option.label,
    description: option.description,
    recommended: option.recommended === true,
  })),
});

const panelModelsOf = (
  registry: ModelRegistry,
  references: readonly [string, string, string],
): [Model<Api>, Model<Api>, Model<Api>] | undefined => {
  const [first, second, third] = references.map((reference) => {
    const parsed = parseModelReference(reference);

    // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model ID, not an array predicate and thisArg.
    return parsed === undefined ? undefined : registry.find(parsed.provider, parsed.id);
  });

  if (first === undefined || second === undefined || third === undefined) {
    return undefined;
  }

  return [first, second, third];
};

const agentVerdict = (confidence: number | undefined): JudgeVerdict =>
  confidence === undefined ? { kind: 'unavailable' } : { kind: 'answered', confidence };

const usesExamples = (variant: ShadowVariant): boolean =>
  variant === 'classifierExamples' || variant === 'panelExamples';

export const variantModels = (variant: ShadowVariant, config: QuestionGateModels): string[] => {
  if (variant === 'classifier' || variant === 'classifierExamples') {
    return [config.classifier];
  }

  if (variant === 'panel' || variant === 'panelExamples') {
    return [...config.panel];
  }

  return [];
};

export const prepareJudges = (
  registry: ModelRegistry,
  config: QuestionGateConfig & { shadow: ShadowConfig },
): PreparedJudges => {
  const examples = config.shadow.examples;
  const hasExamples = examples.length > 0;
  const panelModels = panelModelsOf(registry, config.panel);

  const members: [PanelMember, PanelMember, PanelMember] | undefined =
    panelModels === undefined
      ? undefined
      : [
          panelMember(registry, panelModels[0]),
          panelMember(registry, panelModels[1]),
          panelMember(registry, panelModels[2]),
        ];

  const classify: ClassifyQuestion = (state, choiceQuestion, judgeSignal) =>
    classifyChoice(
      { modelRegistry: registry },
      config.classifier,
      state,
      choiceQuestion,
      judgeSignal,
    );

  const unavailable: JudgeVerdict = { kind: 'unavailable' };

  const judge = async (
    variant: ShadowVariant,
    question: JudgeQuestion,
    confidence: number | undefined,
    signal: AbortSignal,
  ): Promise<JudgeVerdict> => {
    try {
      if (variant === 'agent') {
        return agentVerdict(confidence);
      }

      if (usesExamples(variant) && !hasExamples) {
        return unavailable;
      }

      const chosenExamples = usesExamples(variant) ? examples : [];

      if (variant === 'classifier' || variant === 'classifierExamples') {
        return await judgeWithClassifier(classify, question, chosenExamples, signal);
      }

      if (members === undefined) {
        return unavailable;
      }

      return await judgeWithPanel(members, question, chosenExamples, signal);
    } catch {
      return { kind: 'error' };
    }
  };

  return { judge };
};
