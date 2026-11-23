import { Type } from 'typebox';
import type { Static, TObjectOptions } from 'typebox';

export type JudgeOption = JudgeQuestion['options'][number];

export type PastOutcome = PastAnswer['outcome'];

const buildJudgeSchemas = (options: TObjectOptions) => {
  const option = Type.Object(
    {
      label: Type.String(),
      description: Type.String(),
      recommended: Type.Boolean(),
    },
    options,
  );

  const question = Type.Object(
    {
      question: Type.String(),
      problem: Type.String(),
      impact: Type.String(),
      options: Type.Array(option),
    },
    options,
  );

  const outcome = Type.Union([
    Type.Object({ kind: Type.Literal('recommended') }, options),
    Type.Object({ kind: Type.Literal('otherOption'), label: Type.String() }, options),
    Type.Object({ kind: Type.Literal('typed'), text: Type.String() }, options),
  ]);

  const pastAnswer = Type.Object(
    {
      time: Type.Number(),
      question,
      outcome,
    },
    options,
  );

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
