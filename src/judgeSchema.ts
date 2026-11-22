import { Type } from 'typebox';
import type { Static } from 'typebox';

const judgeOptionSchema = Type.Object(
  {
    label: Type.String(),
    description: Type.String(),
    recommended: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const judgeQuestionSchema = Type.Object(
  {
    question: Type.String(),
    problem: Type.String(),
    impact: Type.String(),
    options: Type.Array(judgeOptionSchema),
  },
  { additionalProperties: false },
);

const pastOutcomeSchema = Type.Union([
  Type.Object({ kind: Type.Literal('recommended') }, { additionalProperties: false }),
  Type.Object(
    { kind: Type.Literal('otherOption'), label: Type.String() },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('typed'), text: Type.String() },
    { additionalProperties: false },
  ),
]);

export const pastAnswerSchema = Type.Object(
  {
    time: Type.Number(),
    question: judgeQuestionSchema,
    outcome: pastOutcomeSchema,
  },
  { additionalProperties: false },
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
