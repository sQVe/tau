import { Type } from 'typebox';
import type { Static, TProperties, TSchema } from 'typebox';

const objectSchema = <Properties extends TProperties>(properties: Properties, strict: boolean) => {
  const options = strict ? { additionalProperties: false } : {};

  return Type.Object(properties, options);
};

const optionProperties = {
  label: Type.String(),
  description: Type.String(),
  recommended: Type.Boolean(),
};

const judgeOptionSchema = objectSchema(optionProperties, true);

export const openJudgeOptionSchema = objectSchema(optionProperties, false);

const questionProperties = <Options extends TSchema>(options: Options) => ({
  question: Type.String(),
  problem: Type.String(),
  impact: Type.String(),
  options: Type.Array(options),
});

export const openJudgeQuestionSchema = objectSchema(
  questionProperties(openJudgeOptionSchema),
  false,
);

export const judgeQuestionSchema = objectSchema(questionProperties(judgeOptionSchema), true);

const outcomeVariantProperties = {
  recommended: { kind: Type.Literal('recommended') },
  otherOption: { kind: Type.Literal('otherOption'), label: Type.String() },
  typed: { kind: Type.Literal('typed'), text: Type.String() },
};

const outcomeSchemas = (strict: boolean) =>
  [
    objectSchema(outcomeVariantProperties.recommended, strict),
    objectSchema(outcomeVariantProperties.otherOption, strict),
    objectSchema(outcomeVariantProperties.typed, strict),
  ] as const;

export const openPastOutcomeSchema = Type.Union([...outcomeSchemas(false)]);

const pastOutcomeSchema = Type.Union([...outcomeSchemas(true)]);

const pastAnswerProperties = <Question extends TSchema, Outcome extends TSchema>(
  question: Question,
  outcome: Outcome,
) => ({
  time: Type.Number(),
  question,
  outcome,
});

export const openPastAnswerSchema = objectSchema(
  pastAnswerProperties(openJudgeQuestionSchema, openPastOutcomeSchema),
  false,
);

export const pastAnswerSchema = objectSchema(
  pastAnswerProperties(judgeQuestionSchema, pastOutcomeSchema),
  true,
);

export const shadowVariantSchema = Type.Union([
  Type.Literal('classifier'),
  Type.Literal('classifierExamples'),
  Type.Literal('panel'),
  Type.Literal('panelExamples'),
  Type.Literal('agent'),
]);

export type JudgeOption = Static<typeof judgeOptionSchema>;
export type JudgeQuestion = Static<typeof judgeQuestionSchema>;
export type PastOutcome = Static<typeof pastOutcomeSchema>;
export type PastAnswer = Static<typeof pastAnswerSchema>;
export type ShadowVariant = Static<typeof shadowVariantSchema>;
