import { createHash } from 'node:crypto';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { openPastAnswerSchema, shadowVariantSchema } from '../judgeSchema.ts';
import type { PastAnswer, ShadowVariant } from '../judgeSchema.ts';
import { anyItem, isRecord } from '../schema.ts';
import type { KnownKeys } from '../schema.ts';
import { readUserOnlyKey, warnUnknownKeys } from './config.ts';
import type { ConfigLocation, ConfigWarnings } from './config.ts';
import { parseModelReference } from './models.ts';

export interface QuestionGateModels {
  classifier: string;
  panel: readonly [string, string, string];
}

export interface ShadowConfig {
  variant: ShadowVariant;
  cutoff: number;
  examples: PastAnswer[];
}

export type QuestionGateConfig = QuestionGateModels &
  ({ decide: false; shadow?: ShadowConfig } | { decide: true; shadow: ShadowConfig });

const questionGateModelsSchema = Type.Object({
  classifier: Type.String(),
  panel: Type.Tuple([Type.String(), Type.String(), Type.String()]),
  decide: Type.Optional(Type.Unknown()),
  shadow: Type.Optional(Type.Unknown()),
});

// The config schemas accept unknown keys, which warnUnknownKeys reports. Saved records stay strict
// in judgeSchema.ts.
const shadowSchema = Type.Object({
  variant: shadowVariantSchema,
  cutoff: Type.Number({ minimum: 0, maximum: 1 }),
  examples: Type.Optional(Type.Array(openPastAnswerSchema, { maxItems: 5 })),
});

const knownKeysOf = (schema: unknown): KnownKeys => {
  if (!isRecord(schema)) {
    return {};
  }

  const variants = schema.anyOf;

  if (Array.isArray(variants)) {
    return Object.fromEntries(variants.flatMap((variant) => Object.entries(knownKeysOf(variant))));
  }

  const { properties } = schema;

  if (!isRecord(properties)) {
    return {};
  }

  const entries = Object.entries(properties).map(([key, child]) => {
    if (isRecord(child) && child.type === 'array') {
      return [key, { [anyItem]: knownKeysOf(child.items) }] as const;
    }

    const isObject = isRecord(child) && child.type === 'object';
    const isUnion = isRecord(child) && Array.isArray(child.anyOf);
    const nested = isObject || isUnion;

    return [key, nested ? knownKeysOf(child) : true] as const;
  });

  return Object.fromEntries(entries);
};

const knownExampleKeys = knownKeysOf(openPastAnswerSchema);

const knownShadowKeys: KnownKeys = {
  variant: true,
  cutoff: true,
  examples: { [anyItem]: knownExampleKeys },
};

const knownQuestionGateKeys: KnownKeys = {
  classifier: true,
  panel: true,
  decide: true,
  shadow: knownShadowKeys,
};

const modelsMessage =
  'questionGate needs classifier, a provider/model-id string, and panel, an array of three provider/model-id strings.';

const shadowMessage =
  'questionGate shadow needs a variant, a cutoff from 0 to 1, and up to five past-answer examples.';

const decideMessage = 'questionGate decide must be true or false.';

const decideNeedsShadowMessage =
  'questionGate decide needs shadow, the frozen judge and cutoff it uses.';

const invalid = (source: string, message: string): Error =>
  new Error(`Invalid Tau config ${source}: ${message}`);

const requireModelReference = (source: string, value: string): string => {
  if (!parseModelReference(value)) {
    throw invalid(
      source,
      `questionGate model ${JSON.stringify(value)} is not a provider/model-id reference.`,
    );
  }

  return value;
};

const usesExamples = (variant: ShadowVariant): boolean =>
  variant === 'classifierExamples' || variant === 'panelExamples';

const readDecide = (source: string, value: unknown): boolean => {
  if (value === undefined) {
    return false;
  }

  if (typeof value !== 'boolean') {
    throw invalid(source, decideMessage);
  }

  return value;
};

const canonicalQuestion = (question: PastAnswer['question']) => ({
  question: question.question,
  problem: question.problem,
  impact: question.impact,
  options: question.options.map((option) => ({
    label: option.label,
    description: option.description,
    recommended: option.recommended,
  })),
});

const canonicalOutcome = (outcome: PastAnswer['outcome']) => {
  if (outcome.kind === 'recommended') {
    return { kind: outcome.kind };
  }

  if (outcome.kind === 'otherOption') {
    return { kind: outcome.kind, label: outcome.label };
  }

  return { kind: outcome.kind, text: outcome.text };
};

const canonicalExample = (answer: PastAnswer) => ({
  time: answer.time,
  question: canonicalQuestion(answer.question),
  outcome: canonicalOutcome(answer.outcome),
});

const readShadow = (source: string, value: unknown): ShadowConfig | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Value.Check(shadowSchema, value)) {
    throw invalid(source, shadowMessage);
  }

  const examples = (value.examples ?? []).map(canonicalExample);

  if (usesExamples(value.variant) && examples.length === 0) {
    throw invalid(
      source,
      `questionGate shadow variant ${JSON.stringify(value.variant)} needs at least one example.`,
    );
  }

  return { variant: value.variant, cutoff: value.cutoff, examples };
};

const readModels = (
  source: string,
  value: { classifier: string; panel: [string, string, string] },
): QuestionGateModels => {
  const [first, second, third] = value.panel;

  const classifier = requireModelReference(source, value.classifier);

  const panel: [string, string, string] = [
    requireModelReference(source, first),
    requireModelReference(source, second),
    requireModelReference(source, third),
  ];

  return { classifier, panel };
};

export const readQuestionGateConfig = (
  location: ConfigLocation,
  ui: ConfigWarnings,
): QuestionGateConfig | undefined => {
  const user = readUserOnlyKey(location, 'questionGate');

  if (user === undefined) {
    return undefined;
  }

  const { source, value } = user;

  warnUnknownKeys(ui, source, value, knownQuestionGateKeys, 'questionGate');

  if (!Value.Check(questionGateModelsSchema, value)) {
    throw invalid(source, modelsMessage);
  }

  const decide = readDecide(source, value.decide);
  const shadow = readShadow(source, value.shadow);

  if (decide) {
    if (shadow === undefined) {
      throw invalid(source, decideNeedsShadowMessage);
    }

    return { ...readModels(source, value), decide: true, shadow };
  }

  return {
    ...readModels(source, value),
    decide: false,
    ...(shadow === undefined ? {} : { shadow }),
  };
};

export const shadowCohort = (config: QuestionGateConfig & { shadow: ShadowConfig }): string => {
  const canonical = JSON.stringify({
    classifier: config.classifier,
    panel: [...config.panel],
    variant: config.shadow.variant,
    cutoff: config.shadow.cutoff,
    examples: config.shadow.examples.map(canonicalExample),
  });

  return createHash('sha256').update(canonical).digest('hex');
};
