import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

export const delegateReference = (): string => {
  // eslint-disable-next-line node/no-process-env -- The delegate is selected independently of Pi's session model.
  const reference = process.env.TAU_DELEGATE_MODEL;

  return reference == null || reference === '' ? 'openai-codex/gpt-6-luna' : reference;
};

export const resolveDelegate = (context: ExtensionContext, reference = delegateReference()) => {
  const separator = reference.indexOf('/');

  if (separator <= 0 || separator === reference.length - 1 || /\s/.test(reference)) {
    throw new Error(`Invalid delegate model: ${JSON.stringify(reference)}. Use provider/model-id.`);
  }

  const provider = reference.slice(0, separator);
  const id = reference.slice(separator + 1);
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model ID.
  const model = context.modelRegistry.find(provider, id);

  if (!model) {
    throw new Error(`Delegate ${reference} failed: model not found. Check pi --list-models.`);
  }

  return model;
};
