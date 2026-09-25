import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

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

export const delegateReference = (): string => {
  // eslint-disable-next-line node/no-process-env -- The delegate is selected independently of Pi's session model.
  const reference = process.env.TAU_DELEGATE_MODEL;

  return reference == null || reference === '' ? 'openai-codex/gpt-5.6-luna' : reference;
};

export const resolveDelegate = (context: ExtensionContext, reference = delegateReference()) => {
  const parsed = parseModelReference(reference);

  if (!parsed) {
    throw new Error(`Invalid delegate model: ${JSON.stringify(reference)}. Use provider/model-id.`);
  }

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model ID.
  const model = context.modelRegistry.find(parsed.provider, parsed.id);

  if (!model) {
    throw new Error(`Delegate ${reference} failed: model not found. Check pi --list-models.`);
  }

  return model;
};
