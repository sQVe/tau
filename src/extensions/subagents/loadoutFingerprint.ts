import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';

import { isMissingFile } from '../../errors/index.js';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

export const providerCallbacksMatch = (actual: unknown, reconstructed: unknown): boolean => {
  if (typeof actual === 'function' || typeof reconstructed === 'function') {
    return actual === reconstructed;
  }

  if (!isObject(actual) || !isObject(reconstructed)) {
    return true;
  }

  const keys = new Set([...Object.keys(actual), ...Object.keys(reconstructed)]);

  return [...keys].every((key) => providerCallbacksMatch(actual[key], reconstructed[key]));
};

export const modelFingerprint = (model: unknown): string => {
  const serialized = JSON.stringify(model, (_key, value: unknown) => {
    if (typeof value === 'function') {
      return undefined;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)),
      );
    }

    return value;
  });

  return createHash('sha256').update(serialized).digest('hex');
};

const fileDigest = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

// A missing integration is an error worth naming, so Pi reads every recorded path.
export const integrationFingerprint = (paths: string[]): string =>
  modelFingerprint(paths.map((path) => ({ path, digest: fileDigest(path) })));

export const waitForResolution = async <Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> => {
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => {
    cancelled.reject(new Error('Worker resolution cancelled or its budget expired.'));
  };
  signal.addEventListener('abort', abort, { once: true });

  try {
    return await Promise.race([operation, cancelled.promise]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
};

export const providerConfiguration = async (
  registry: ModelRegistry,
  model: { provider: string; id: string },
  signal: AbortSignal = AbortSignal.timeout(10_000),
) => {
  signal.throwIfAborted();
  const provider = registry.getProvider(model.provider);

  if (!provider) {
    throw new Error('Selected worker provider is unavailable.');
  }

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  const selectedModel = registry.find(model.provider, model.id);

  if (!selectedModel) {
    throw new Error('Selected worker model is unavailable.');
  }

  // Pi's compatibility auth API has no signal parameter. Bound our wait; a provider may finish its own auth request later.
  const auth = await waitForResolution(registry.getApiKeyAndHeaders(selectedModel), signal);
  signal.throwIfAborted();

  if (!auth.ok) {
    throw new Error('Selected worker provider authentication is unavailable.');
  }

  const registration = registry.getRegisteredProviderConfig(model.provider);
  const native = registry.getRegisteredNativeProvider(model.provider);

  return { baseUrl: provider.baseUrl, headers: provider.headers, auth, registration, native };
};

export const providerFingerprintValue = (
  configuration: Awaited<ReturnType<typeof providerConfiguration>>,
): string => {
  const { apiKey: _resolvedKey, ...auth } = configuration.auth;
  let modelsConfiguration: string | null = null;

  try {
    modelsConfiguration = createHash('sha256')
      .update(readFileSync(join(getAgentDir(), 'models.json')))
      .digest('hex');
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  // This binds the saved file, not registry provenance. Live settings must also match a fresh reconstruction.
  return modelFingerprint({ ...configuration, auth, modelsConfiguration });
};

export const providerFingerprint = async (
  registry: ModelRegistry,
  model: { provider: string; id: string },
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<string> => {
  const configuration = await providerConfiguration(registry, model, signal);

  // Pi distributions can minify SDK wrappers differently. Compare implementations in the parent process, not across processes.
  return providerFingerprintValue(configuration);
};

export const checkProviderConfiguration = (
  parent: Awaited<ReturnType<typeof providerConfiguration>>,
  reconstructed: Awaited<ReturnType<typeof providerConfiguration>>,
): void => {
  // Matching source text cannot establish equality of captured settings. Only replayable callback identities are accepted.
  // A disk hash cannot establish what a live registry loaded. Key differences within this check are not evidence of rotation.
  if (
    !providerCallbacksMatch(parent, reconstructed) ||
    modelFingerprint(parent) !== modelFingerprint(reconstructed)
  ) {
    throw new Error(
      'Worker cannot reproduce current provider authentication, headers, or streaming integration. Differing resolved credentials during validation are unsupported.',
    );
  }
};
