import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { readTauConfig } from '../tauConfig/index.js';
import type { ConfigFile, ConfigLocation } from '../tauConfig/index.js';
import { effectiveAllowedModels } from './allowedModels.js';

// The provider ends at the first slash; the model ID may contain more, as in openrouter/meta/llama.
export const modelReferencePattern = '^[^/\\s]+/[^\\s]+$';

const modelReference = new RegExp(modelReferencePattern);

export const parseModelReference = (reference: string) => {
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

// Tau's config may restrict every model Tau selects; without allowedModels, any model is allowed.
export const requireAllowedModel = (reference: string, location: ConfigLocation): void => {
  const allowed = effectiveAllowedModels(readTauConfig(location).files.map(allowedModelsLayer));

  if (allowed && !allowed.models.includes(reference)) {
    throw new Error(
      `Model ${reference} is not allowed. allowedModels from ${allowed.sources.join(' and ')}: ${allowed.models.join(', ') || 'none'}. Tau does not fall back to another model.`,
    );
  }
};

export const delegateReference = (): string => {
  // eslint-disable-next-line node/no-process-env -- The delegate is selected independently of Pi's session model.
  const reference = process.env.TAU_DELEGATE_MODEL;

  return reference == null || reference === '' ? 'openai-codex/gpt-5.6-luna' : reference;
};

export const resolveDelegate = (
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted' | 'modelRegistry'>,
  reference = delegateReference(),
) => {
  const parsed = parseModelReference(reference);

  if (!parsed) {
    throw new Error(`Invalid delegate model: ${JSON.stringify(reference)}. Use provider/model-id.`);
  }

  requireAllowedModel(reference, {
    cwd: context.cwd,
    agentDirectory: getAgentDir(),
    projectTrusted: context.isProjectTrusted(),
  });

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model ID.
  const model = context.modelRegistry.find(parsed.provider, parsed.id);

  if (!model) {
    throw new Error(`Delegate ${reference} failed: model not found. Check pi --list-models.`);
  }

  return model;
};
