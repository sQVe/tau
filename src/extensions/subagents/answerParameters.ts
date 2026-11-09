import { Type } from 'typebox';
import type { Static } from 'typebox';

import { uuidPattern } from './assignment.js';

export const answerParameters = Type.Object(
  {
    assignmentId: Type.String({ pattern: uuidPattern }),
    questionId: Type.String({ pattern: uuidPattern }),
    answer: Type.String({ minLength: 1, maxLength: 32_000 }),
  },
  { additionalProperties: false },
);

export type AnswerParameters = Static<typeof answerParameters>;
