import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readUserOnlyKey } from './config.js';
import type { ConfigLocation } from './config.js';
import { parseModelReference } from './models.js';

export interface QuestionGateModels {
  classifier: string;
  panel: readonly [string, string, string];
}

const questionGateModelsSchema = Type.Object(
  {
    classifier: Type.String(),
    panel: Type.Tuple([Type.String(), Type.String(), Type.String()]),
  },
  { additionalProperties: false },
);

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

export const readQuestionGateModels = (
  location: ConfigLocation,
): QuestionGateModels | undefined => {
  const user = readUserOnlyKey(location, 'questionGate');

  if (user === undefined) {
    return undefined;
  }

  const { source, value } = user;

  if (!Value.Check(questionGateModelsSchema, value)) {
    throw invalid(
      source,
      'questionGate needs classifier, a provider/model-id string, and panel, an array of three provider/model-id strings.',
    );
  }

  const [first, second, third] = value.panel;

  return {
    classifier: requireModelReference(source, value.classifier),
    panel: [
      requireModelReference(source, first),
      requireModelReference(source, second),
      requireModelReference(source, third),
    ],
  };
};
