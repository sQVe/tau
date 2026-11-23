import { Type } from 'typebox';
import type { Static, TObjectOptions, TSchema } from 'typebox';

export type JudgeOption = JudgeQuestion['options'][number];

export type PastOutcome = PastAnswer['outcome'];

const optionProperties = {
  label: Type.String(),
  description: Type.String(),
  recommended: Type.Boolean(),
};

const questionProperties = <Options extends TSchema>(options: Options) => ({
  question: Type.String(),
  problem: Type.String(),
  impact: Type.String(),
  options: Type.Array(options),
});

const outcomeVariantProperties = {
  recommended: { kind: Type.Literal('recommended') },
  otherOption: { kind: Type.Literal('otherOption'), label: Type.String() },
  typed: { kind: Type.Literal('typed'), text: Type.String() },
};

const pastAnswerProperties = <Question extends TSchema, Outcome extends TSchema>(
  question: Question,
  outcome: Outcome,
) => ({
  time: Type.Number(),
  question,
  outcome,
});

const buildJudgeSchemas = (options: TObjectOptions) => {
  const option = Type.Object(optionProperties, options);

  const question = Type.Object(questionProperties(option), options);

  const outcome = Type.Union([
    Type.Object(outcomeVariantProperties.recommended, options),
    Type.Object(outcomeVariantProperties.otherOption, options),
    Type.Object(outcomeVariantProperties.typed, options),
  ]);

  const pastAnswer = Type.Object(pastAnswerProperties(question, outcome), options);

  return { question, pastAnswer };
};

const strictJudgeSchemas = buildJudgeSchemas({ additionalProperties: false });
const openJudgeSchemas = buildJudgeSchemas({});

export const judgeQuestionSchema = strictJudgeSchemas.question;
export const pastAnswerSchema = strictJudgeSchemas.pastAnswer;
export const openPastAnswerSchema = openJudgeSchemas.pastAnswer;

export const shadowVariantSchema = Type.Union([
  Type.Literal('classifier'),
  Type.Literal('classifierExamples'),
  Type.Literal('panel'),
  Type.Literal('panelExamples'),
  Type.Literal('agent'),
]);

export type JudgeQuestion = Static<typeof judgeQuestionSchema>;
export type PastAnswer = Static<typeof pastAnswerSchema>;
export type ShadowVariant = Static<typeof shadowVariantSchema>;
