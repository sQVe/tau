import type { Api, Model } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readTauConfig } from '../tauConfig.js';
import type { ConfigFile, ConfigLocation } from '../tauConfig.js';
import { effectiveAllowedModels } from './allowedModels.js';
import type { AllowedModels } from './allowedModels.js';

interface ModelReference {
  provider: string;
  id: string;
}

// The provider ends at the first slash; the model ID may contain more, as in openrouter/meta/llama.
export const modelReferencePattern = '^[^/\\s]+/[^\\s]+$';

const modelReference = new RegExp(modelReferencePattern);

export const parseModelReference = (reference: string): ModelReference | undefined => {
  if (!modelReference.test(reference)) {
    return undefined;
  }

  const separator = reference.indexOf('/');

  return { provider: reference.slice(0, separator), id: reference.slice(separator + 1) };
};

const allowedModelsFileSchema = Type.Object({
  allowedModels: Type.Optional(Type.Array(Type.String())),
});

const allowedModelsLayer = ({ source, value }: ConfigFile) => {
  if (!Value.Check(allowedModelsFileSchema, value)) {
    throw new Error(
      `Invalid Tau config ${source}: allowedModels must be an array of provider/model-id strings.`,
    );
  }

  const invalid = value.allowedModels?.find((entry) => !parseModelReference(entry));

  if (invalid !== undefined) {
    throw new Error(
      `Invalid Tau config ${source}: allowedModels entry ${JSON.stringify(invalid)} is not provider/model-id.`,
    );
  }

  return { source, models: value.allowedModels };
};

// Without allowedModels in either file, the result is undefined and any model is allowed.
export const readAllowedModels = (location: ConfigLocation): AllowedModels | undefined =>
  effectiveAllowedModels(readTauConfig(location).files.map(allowedModelsLayer));

// Tau's config may restrict every model Tau selects.
export const requireAllowedModel = (reference: string, location: ConfigLocation): void => {
  const allowed = readAllowedModels(location);

  if (allowed && !allowed.models.includes(reference)) {
    throw new Error(
      `Model ${reference} is not allowed. allowedModels from ${allowed.sources.join(' and ')}: ${allowed.models.join(', ') || 'none'}. Tau does not fall back to another model.`,
    );
  }
};

export const resolveAllowedModel = (
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'modelRegistry'>,
  reference: string,
): Model<Api> => {
  const parsed = parseModelReference(reference);

  if (!parsed) {
    throw new Error(`Invalid model ${JSON.stringify(reference)}. Use provider/model-id.`);
  }

  requireAllowedModel(reference, {
    cwd: context.cwd,
    agentDirectory: getAgentDir(),
    projectTrusted: context.isProjectTrusted(),
  });

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model ID.
  const model = context.modelRegistry.find(parsed.provider, parsed.id);

  if (!model) {
    throw new Error(`Model ${reference} not found. Check pi --list-models.`);
  }

  return model;
};
