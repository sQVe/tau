import { parseModelReference } from '../config/models.js';

// Pi treats a provider prefix in --model as a hint and can fall back to another provider's model
// with the same ID. --provider pins the provider that validation accepted.
const modelArgumentsOf = (model: string | undefined): string[] => {
  if (model === undefined) {
    return [];
  }

  const reference = parseModelReference(model);

  if (reference === undefined) {
    return ['--model', model];
  }

  return ['--provider', reference.provider, '--model', reference.id];
};

export const piArguments = (options: {
  model: string | undefined;
  session: string | undefined;
  environment: Record<string, string> | undefined;
  message: string | undefined;
}): string[] => {
  const environment = Object.entries(options.environment ?? {});

  const envArguments =
    environment.length === 0
      ? []
      : ['env', ...environment.map(([name, value]) => `${name}=${value}`)];

  const sessionArguments = options.session === undefined ? [] : ['--session', options.session];
  const modelArguments = modelArgumentsOf(options.model);
  const messageArguments = options.message === undefined ? [] : [options.message];

  return [...envArguments, 'pi', ...sessionArguments, ...modelArguments, ...messageArguments];
};
