import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { clampThinkingLevel } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  ModelRegistry,
  parseArgs,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { discoverProfiles } from './profiles.js';
import type { Loadout } from './types.js';

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

export const integrationFingerprint = (paths: string[]): string =>
  modelFingerprint(
    paths.map((path) => ({
      path,
      digest: createHash('sha256').update(readFileSync(path)).digest('hex'),
    })),
  );

const parentExtensionPaths = (pi: Pick<ExtensionAPI, 'getAllTools' | 'getCommands'>) => {
  const cliArguments = parseArgs(process.argv.slice(2));
  if (cliArguments.apiKey || cliArguments.unknownFlags.size) {
    throw new Error(
      'Worker launch cannot reproduce parent API-key or extension-flag overrides. Use saved configuration.',
    );
  }
  const provenance = [
    ...pi.getAllTools().map((tool) => tool.sourceInfo),
    ...pi
      .getCommands()
      .filter((command) => command.source === 'extension')
      .map((command) => command.sourceInfo),
  ];
  if (provenance.some((source) => source.source === 'sdk')) {
    throw new Error('Worker launch cannot reproduce inline SDK integrations.');
  }

  return [
    ...new Set([
      ...(cliArguments.extensions ?? []),
      ...provenance
        .filter((source) => source.source !== 'builtin' && !source.path.startsWith('<'))
        .map((source) => source.path),
    ]),
  ];
};

const waitForResolution = async <Result>(
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
  if (!auth.ok) {
    throw new Error('Selected worker provider authentication is unavailable.');
  }
  const registration = registry.getRegisteredProviderConfig(model.provider);
  const native = registry.getRegisteredNativeProvider(model.provider);

  return { baseUrl: provider.baseUrl, headers: provider.headers, auth, registration, native };
};

export const providerFingerprint = async (
  registry: ModelRegistry,
  model: { provider: string; id: string },
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<string> => {
  const configuration = await providerConfiguration(registry, model, signal);
  // Pi distributions can minify SDK wrappers differently. Compare implementations in the parent process, not across processes.
  return modelFingerprint(configuration);
};

const resolveModel = (
  explicit: string | undefined,
  configured: string | undefined,
  registry: ModelRegistry,
) => {
  // oxlint-disable-next-line node/no-process-env -- Explicit worker model configuration has no implicit parent-model fallback.
  const model = explicit ?? configured ?? process.env.TAU_SUBAGENT_MODEL;
  if (!model || !/^[^/\s]+\/[^\s]+$/.test(model)) {
    throw new Error('Set an exact worker model as provider/id; there is no fallback.');
  }
  const separator = model.indexOf('/');
  const selectedModel = registry.find(model.slice(0, separator), model.slice(separator + 1));
  if (!selectedModel) {
    throw new Error(`Worker model unavailable: ${model}`);
  }

  return model;
};

const checkProviderConfiguration = (parent: unknown, reconstructed: unknown): void => {
  // Matching source text cannot establish equality of captured settings. Only replayable callback identities are accepted.
  if (
    !providerCallbacksMatch(parent, reconstructed) ||
    modelFingerprint(parent) !== modelFingerprint(reconstructed)
  ) {
    throw new Error(
      'Worker cannot reproduce parent provider authentication, headers, or streaming integration.',
    );
  }
};

export const resolveLoadout = async (
  input: { profile: string; cwd?: string; model?: string; harness?: string; permissions: string },
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>,
  pi: Pick<ExtensionAPI, 'getAllTools' | 'getCommands'>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<Loadout> => {
  signal.throwIfAborted();
  if (!['pi', undefined].includes(input.harness)) {
    throw new Error('Only Pi workers are supported.');
  }
  if (input.permissions !== 'trusted-full-tools') {
    throw new Error('Workers require explicit trusted-full-tools permission.');
  }
  if (!context.isProjectTrusted()) {
    throw new Error('Worker launch requires a trusted project.');
  }

  const cwd = realpathSync(resolve(context.cwd, input.cwd ?? '.'));
  // A different project needs its own trust decision, not the parent's inherited approval.
  if (cwd !== realpathSync(context.cwd)) {
    throw new Error('Launch from the target cwd after trusting that project.');
  }
  const agentDirectory = realpathSync(getAgentDir());
  const profile = discoverProfiles(cwd, agentDirectory, true).find(
    (candidate) => candidate.name === input.profile,
  );
  if (!profile) {
    throw new Error(`Worker profile not found: ${input.profile}`);
  }
  const model = resolveModel(input.model, profile.model, context.modelRegistry);
  const separator = model.indexOf('/');

  const additionalExtensionPaths = parentExtensionPaths(pi);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: agentDirectory,
    additionalExtensionPaths,
  });
  await waitForResolution(loader.reload(), signal);
  const loaded = loader.getExtensions();
  if (loaded.errors.length) {
    throw new Error(`Worker integration load failed: ${JSON.stringify(loaded.errors)}`);
  }
  const safety = loaded.extensions.find(
    (extension) => extension.commands.has('cc-safety-net') && extension.handlers.has('tool_call'),
  );
  if (!safety) {
    throw new Error('CC Safety Net must be loaded, with its tool_call handler active.');
  }

  const reconstructed = await ModelRuntime.create({
    authPath: join(agentDirectory, 'auth.json'),
    modelsPath: join(agentDirectory, 'models.json'),
    refreshOnCreate: false,
    signal,
  });
  const registry = new ModelRegistry(reconstructed);
  for (const registration of loaded.runtime.pendingProviderRegistrations) {
    registry.registerProvider(registration.name, registration.config);
  }
  for (const registration of loaded.runtime.pendingNativeProviderRegistrations) {
    registry.registerProvider(registration.provider);
  }
  const resolvedModel = registry.find(model.slice(0, separator), model.slice(separator + 1));
  const parentModel = context.modelRegistry.find(
    model.slice(0, separator),
    model.slice(separator + 1),
  );
  if (
    !resolvedModel ||
    !parentModel ||
    modelFingerprint(resolvedModel) !== modelFingerprint(parentModel)
  ) {
    throw new Error(
      'Worker cannot reproduce the parent model configuration. Runtime overrides are unsupported.',
    );
  }

  const reconstructedConfiguration = await providerConfiguration(registry, resolvedModel, signal);
  const parentConfiguration = await providerConfiguration(
    context.modelRegistry,
    parentModel,
    signal,
  );
  checkProviderConfiguration(parentConfiguration, reconstructedConfiguration);

  const integrations = loaded.extensions.map((extension) => realpathSync(extension.path));
  const tools = [
    ...new Set([
      'read',
      'bash',
      'edit',
      'write',
      ...loaded.extensions.flatMap((extension) => Array.from(extension.tools.keys())),
      'subagent_report',
    ]),
  ].filter((tool) => !['subagent', 'subagent_status', 'subagent_cancel'].includes(tool));

  return {
    profile: profile.name,
    role: profile.role,
    model,
    modelFingerprint: modelFingerprint(resolvedModel),
    providerFingerprint: modelFingerprint(reconstructedConfiguration),
    thinking: clampThinkingLevel(resolvedModel, profile.thinking),
    cwd,
    agentDirectory,
    permissions: 'trusted-full-tools',
    tools,
    integrations,
    integrationFingerprint: integrationFingerprint(integrations),
    safetyExtension: realpathSync(safety.path),
    instructions: profile.instructions,
  };
};

export const checkWorkerRuntime = async (
  loadout: Loadout,
  pi: Pick<ExtensionAPI, 'getThinkingLevel' | 'getCommands' | 'getAllTools' | 'setActiveTools'>,
  context: Pick<ExtensionContext, 'model' | 'cwd' | 'modelRegistry' | 'isProjectTrusted'>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<void> => {
  if (!context.isProjectTrusted()) {
    throw new Error('Worker project trust was refused.');
  }
  if (integrationFingerprint(loadout.integrations) !== loadout.integrationFingerprint) {
    throw new Error('Worker integration source changed after resolution.');
  }
  const model = context.model;
  if (
    !model ||
    `${model.provider}/${model.id}` !== loadout.model ||
    modelFingerprint(model) !== loadout.modelFingerprint ||
    pi.getThinkingLevel() !== loadout.thinking
  ) {
    throw new Error(
      'Worker model or thinking differs from the saved loadout; no fallback allowed.',
    );
  }
  if (
    (await providerFingerprint(context.modelRegistry, model, signal)) !==
    loadout.providerFingerprint
  ) {
    throw new Error('Worker provider configuration differs from the saved loadout.');
  }
  if (
    realpathSync(context.cwd) !== loadout.cwd ||
    realpathSync(getAgentDir()) !== loadout.agentDirectory
  ) {
    throw new Error('Worker cwd or configuration directory changed.');
  }
  const safety = pi.getCommands().find((command) => command.name === 'cc-safety-net');
  if (!safety || realpathSync(safety.sourceInfo.path) !== loadout.safetyExtension) {
    throw new Error('The saved CC Safety Net integration is not active.');
  }
  const available = new Set(pi.getAllTools().map((tool) => tool.name));
  if (loadout.tools.some((tool) => !available.has(tool))) {
    throw new Error('Saved worker tools are unavailable.');
  }

  pi.setActiveTools(loadout.tools);
};
