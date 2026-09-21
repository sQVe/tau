import { realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { clampThinkingLevel } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  ModelRegistry,
  parseArgs,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';

import { inheritedInstructions } from './admission.js';
import { resolveGenericLoadout } from './genericLoadout.js';
import type { NativeLaunchInput } from './genericLoadout.js';
import {
  checkProviderConfiguration,
  integrationFingerprint,
  modelFingerprint,
  providerConfiguration,
  providerFingerprintValue,
  waitForResolution,
} from './loadoutFingerprint.js';
import { resolveProfile } from './profiles.js';
import { harnessOf, isPiLoadout, loadoutSchema, textLimit } from './types.js';
import type { Loadout, PiLoadout, Profile, Task } from './types.js';

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

const reconstructIntegrations = async (
  cwd: string,
  agentDirectory: string,
  selection: { noExtensions: boolean; additionalExtensionPaths: string[] },
  signal: AbortSignal,
) => {
  const loader = new DefaultResourceLoader({ cwd, agentDir: agentDirectory, ...selection });
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
    signal,
  });
  signal.throwIfAborted();

  const registry = new ModelRegistry(reconstructed);

  for (const registration of loaded.runtime.pendingProviderRegistrations) {
    registry.registerProvider(registration.name, registration.config);
  }

  for (const registration of loaded.runtime.pendingNativeProviderRegistrations) {
    registry.registerProvider(registration.provider);
  }

  if (registry.getError()) {
    throw new Error('Worker model configuration could not be reconstructed.');
  }

  return { loaded, registry, safety };
};

const piWorkerTools = (extensionTools: Iterable<string>): string[] =>
  [
    ...new Set([
      'read',
      'bash',
      'edit',
      'write',
      ...extensionTools,
      'subagent_report',
      'subagent_question',
    ]),
  ].filter((tool) => tool !== 'ask_user_question');

const requirePiPermissions = (input: NativeLaunchInput): void => {
  if (input.permissions !== 'trusted-full-tools') {
    throw new Error('Workers require explicit trusted-full-tools permission.');
  }

  if (input.nativeArguments !== undefined || input.reportDirectory !== undefined) {
    throw new Error('Pi workers do not accept native launch arguments or report directories.');
  }
};

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

  return {
    noExtensions: cliArguments.noExtensions ?? false,
    additionalExtensionPaths: [
      ...new Set([
        ...(cliArguments.extensions ?? []),
        ...provenance
          .filter((source) => source.source !== 'builtin' && !source.path.startsWith('<'))
          .map((source) => source.path),
      ]),
    ],
  };
};

const resolveLaunchPlan = (
  input: NativeLaunchInput & { profile: string; cwd?: string; harness?: string },
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
) => {
  if (!context.isProjectTrusted()) {
    throw new Error('Worker launch requires a trusted project.');
  }

  const cwd = realpathSync(resolve(context.cwd, input.cwd ?? '.'));

  // A different project needs its own trust decision, not the parent's inherited approval.
  if (cwd !== realpathSync(context.cwd)) {
    throw new Error('Launch from the target cwd after trusting that project.');
  }

  const agentDirectory = realpathSync(getAgentDir());
  const profile = resolveProfile(cwd, agentDirectory, true, input.profile);

  if (!profile) {
    throw new Error(`Worker profile not found: ${input.profile}`);
  }

  const kind = input.harness ?? profile.harness;

  if (profile.harnessSpecified && profile.harness !== kind) {
    throw new Error(`Profile ${profile.name} is a ${profile.harness} profile, not a ${kind} one.`);
  }

  return { cwd, agentDirectory, profile, kind };
};

const requireMatchingModel = <Model>(
  resolvedModel: Model | undefined,
  parentModel: Model | undefined,
): { resolvedModel: Model; parentModel: Model } => {
  if (
    !resolvedModel ||
    !parentModel ||
    modelFingerprint(resolvedModel) !== modelFingerprint(parentModel)
  ) {
    throw new Error(
      'Worker cannot reproduce the parent model configuration. Runtime overrides are unsupported.',
    );
  }

  return { resolvedModel, parentModel };
};

export const resolveLoadout = async (
  input: NativeLaunchInput & { profile: string; cwd?: string; harness?: string },
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'> &
    Partial<Pick<ExtensionContext, 'hasUI' | 'ui'>>,
  pi: Pick<ExtensionAPI, 'getAllTools' | 'getCommands'>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<Loadout> => {
  signal.throwIfAborted();
  const { cwd, agentDirectory, profile, kind } = resolveLaunchPlan(input, context);

  if (kind !== 'pi') {
    return resolveGenericLoadout({ input, profile, kind, cwd, context, signal });
  }

  requirePiPermissions(input);

  const model = resolveModel(input.model, profile.model, context.modelRegistry);
  const separator = model.indexOf('/');
  const selection = parentExtensionPaths(pi);
  const { loaded, registry, safety } = await reconstructIntegrations(
    cwd,
    agentDirectory,
    selection,
    signal,
  );
  const { resolvedModel, parentModel } = requireMatchingModel(
    registry.find(model.slice(0, separator), model.slice(separator + 1)),
    context.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1)),
  );
  const reconstructedConfiguration = await providerConfiguration(registry, resolvedModel, signal);
  const parentConfiguration = await providerConfiguration(
    context.modelRegistry,
    parentModel,
    signal,
  );
  checkProviderConfiguration(parentConfiguration, reconstructedConfiguration);

  const integrations = loaded.extensions.map((extension) => realpathSync(extension.path));
  const tools = piWorkerTools(
    loaded.extensions.flatMap((extension) => Array.from(extension.tools.keys())),
  );

  return {
    harness: 'pi',
    profile: profile.name,
    role: profile.role,
    model,
    modelFingerprint: modelFingerprint(resolvedModel),
    providerFingerprint: providerFingerprintValue(reconstructedConfiguration),
    providerFingerprintVersion: 2,
    thinking: clampThinkingLevel(resolvedModel, profile.thinking),
    cwd,
    agentDirectory,
    permissions: 'trusted-full-tools',
    tools,
    noExtensions: selection.noExtensions,
    integrations,
    integrationFingerprint: integrationFingerprint(integrations),
    safetyExtension: realpathSync(safety.path),
    instructions: profile.instructions,
  };
};

const validateSavedLoadoutShape = (
  value: unknown,
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
): PiLoadout => {
  if (!Value.Check(loadoutSchema, value)) {
    throw new Error('Invalid saved worker loadout.');
  }

  const loadout = value;

  if (!isPiLoadout(loadout)) {
    throw new Error('Non-Pi continuation is unsupported; start a fresh task.');
  }

  if (!context.isProjectTrusted()) {
    throw new Error('Saved worker replay requires a currently trusted project.');
  }

  if (
    realpathSync(context.cwd) !== loadout.cwd ||
    realpathSync(getAgentDir()) !== loadout.agentDirectory
  ) {
    throw new Error('Worker cwd or configuration directory changed.');
  }

  const fingerprint = integrationFingerprint;

  if (
    !loadout.integrations.every(isAbsolute) ||
    !loadout.integrations.includes(loadout.safetyExtension) ||
    fingerprint(loadout.integrations) !== loadout.integrationFingerprint
  ) {
    throw new Error('Saved worker integration source changed or safety integration is missing.');
  }

  return loadout;
};

export const validateSavedLoadout = async (
  value: unknown,
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<PiLoadout> => {
  signal.throwIfAborted();
  const loadout = validateSavedLoadoutShape(value, context);
  const { loaded, registry, safety } = await reconstructIntegrations(
    loadout.cwd,
    loadout.agentDirectory,
    { noExtensions: true, additionalExtensionPaths: loadout.integrations },
    signal,
  );
  const integrations = loaded.extensions.map((extension) => realpathSync(extension.path));

  if (
    modelFingerprint(integrations) !== modelFingerprint(loadout.integrations) ||
    realpathSync(safety.path) !== loadout.safetyExtension
  ) {
    throw new Error('Saved worker integrations could not be replayed exactly.');
  }

  const tools = new Set(
    piWorkerTools(loaded.extensions.flatMap((extension) => Array.from(extension.tools.keys()))),
  );

  if (loadout.tools.length !== tools.size || loadout.tools.some((tool) => !tools.has(tool))) {
    throw new Error('Saved worker tools do not match the current worker runtime.');
  }

  const separator = loadout.model.indexOf('/');
  const provider = loadout.model.slice(0, separator);
  const modelId = loadout.model.slice(separator + 1);
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  const model = registry.find(provider, modelId);
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  const currentModel = context.modelRegistry.find(provider, modelId);

  if (!model || !currentModel) {
    throw new Error('Saved worker model or thinking cannot be reproduced; no fallback allowed.');
  }

  const sameModelFingerprint =
    modelFingerprint(model) === loadout.modelFingerprint &&
    modelFingerprint(currentModel) === loadout.modelFingerprint;

  if (!sameModelFingerprint || clampThinkingLevel(model, loadout.thinking) !== loadout.thinking) {
    throw new Error('Saved worker model or thinking cannot be reproduced; no fallback allowed.');
  }

  const configuration = await providerConfiguration(registry, model, signal);
  const currentConfiguration = await providerConfiguration(
    context.modelRegistry,
    currentModel,
    signal,
  );
  checkProviderConfiguration(currentConfiguration, configuration);

  if (providerFingerprintValue(configuration) !== loadout.providerFingerprint) {
    throw new Error(
      'Worker provider configuration differs from the saved loadout. Changed credentials or auth headers require a fresh task.',
    );
  }

  signal.throwIfAborted();

  return loadout;
};

const checkLiveProviderConfiguration = async (
  registry: ModelRegistry,
  model: NonNullable<ExtensionContext['model']>,
  signal: AbortSignal,
) => {
  const runtime = await ModelRuntime.create({
    authPath: join(getAgentDir(), 'auth.json'),
    modelsPath: join(getAgentDir(), 'models.json'),
    signal,
  });
  signal.throwIfAborted();

  const reconstructed = new ModelRegistry(runtime);
  // Replay public provider declarations without running extension factories again inside an active worker.
  const registration = registry.getRegisteredProviderConfig(model.provider);
  const native = registry.getRegisteredNativeProvider(model.provider);

  if (registration) {
    reconstructed.registerProvider(model.provider, registration);
  }

  if (native) {
    reconstructed.registerProvider(native);
  }

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  const reconstructedModel = reconstructed.find(model.provider, model.id);

  if (
    reconstructed.getError() ||
    !reconstructedModel ||
    modelFingerprint(reconstructedModel) !== modelFingerprint(model)
  ) {
    throw new Error('Worker cannot reproduce its current model configuration.');
  }

  const current = await providerConfiguration(registry, model, signal);
  const expected = await providerConfiguration(reconstructed, reconstructedModel, signal);
  checkProviderConfiguration(current, expected);

  return current;
};

const requireActiveWorkerTools = (
  loadout: PiLoadout,
  pi: Pick<ExtensionAPI, 'getAllTools' | 'setActiveTools'>,
): void => {
  const available = new Set(
    piWorkerTools(
      pi
        .getAllTools()
        .filter(
          (tool: { sourceInfo?: { source?: string } }) => tool.sourceInfo?.source !== 'builtin',
        )
        .map((tool) => tool.name),
    ),
  );

  if (
    loadout.tools.length !== available.size ||
    loadout.tools.some((tool) => !available.has(tool))
  ) {
    throw new Error('Saved worker tools do not match the current worker runtime.');
  }

  pi.setActiveTools(loadout.tools);
};

const requireSavedWorkerDirectory = (loadout: PiLoadout, context: { cwd: string }): void => {
  if (
    realpathSync(context.cwd) !== loadout.cwd ||
    realpathSync(getAgentDir()) !== loadout.agentDirectory
  ) {
    throw new Error('Worker cwd or configuration directory changed.');
  }
};

export const checkWorkerRuntime = async (
  loadout: PiLoadout,
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

  if (!model) {
    throw new Error(
      'Worker model or thinking differs from the saved loadout; no fallback allowed.',
    );
  }

  const matchesSavedModel =
    `${model.provider}/${model.id}` === loadout.model &&
    modelFingerprint(model) === loadout.modelFingerprint;

  if (!matchesSavedModel || pi.getThinkingLevel() !== loadout.thinking) {
    throw new Error(
      'Worker model or thinking differs from the saved loadout; no fallback allowed.',
    );
  }

  const configuration = await checkLiveProviderConfiguration(context.modelRegistry, model, signal);

  if (providerFingerprintValue(configuration) !== loadout.providerFingerprint) {
    throw new Error(
      'Worker provider configuration differs from the saved loadout. Changed credentials or auth headers require a fresh task.',
    );
  }

  requireSavedWorkerDirectory(loadout, context);

  const safety = pi.getCommands().find((command) => command.name === 'cc-safety-net');

  if (!safety || realpathSync(safety.sourceInfo.path) !== loadout.safetyExtension) {
    throw new Error('The saved CC Safety Net integration is not active.');
  }

  requireActiveWorkerTools(loadout, pi);
};

const hasHarnessConflict = (profile: Profile, inherited: PiLoadout): boolean =>
  profile.harnessSpecified === true && profile.harness !== harnessOf(inherited);

const hasModelConflict = (profile: Profile, inherited: PiLoadout): boolean =>
  profile.model !== undefined && profile.model !== inherited.model;

const hasThinkingConflict = (profile: Profile, inherited: PiLoadout): boolean =>
  profile.thinkingSpecified === true && profile.thinking !== inherited.thinking;

const conflictsWithInheritedSettings = (profile: Profile, inherited: PiLoadout): boolean =>
  hasHarnessConflict(profile, inherited) ||
  hasModelConflict(profile, inherited) ||
  hasThinkingConflict(profile, inherited);

const inheritedProfile = (parent: Task, input: { profile: string }, trusted: boolean) => {
  if (!isPiLoadout(parent.loadout)) {
    throw new Error('Non-Pi workers have no Tau nesting channel.');
  }

  const profile = resolveProfile(
    parent.loadout.cwd,
    parent.loadout.agentDirectory,
    trusted,
    input.profile,
  );

  if (!profile || conflictsWithInheritedSettings(profile, parent.loadout)) {
    throw new Error('Nested profile is unavailable or conflicts with inherited model settings.');
  }

  const instructions = `${inheritedInstructions(parent)}${profile.instructions}`;

  if (instructions.length > textLimit) {
    throw new Error(
      `Inherited instructions and parent-assigned scope reached ${instructions.length} characters, over the ${textLimit} limit. Delegate a shorter task or choose a shorter profile.`,
    );
  }

  return { profile, instructions };
};

interface InheritedLoadoutRequest {
  parent: Task;
  input: { profile: string; cwd?: string; model?: string; harness?: string; permissions: string };
  context: ExtensionContext;
  pi: ExtensionAPI;
  signal: AbortSignal;
}

const hasHarnessOverride = (input: InheritedLoadoutRequest['input']): boolean =>
  input.harness !== undefined && input.harness !== 'pi';

const hasModelOverride = (input: InheritedLoadoutRequest['input'], inherited: PiLoadout): boolean =>
  input.model !== undefined && input.model !== inherited.model;

const changesInheritedSettings = (
  input: InheritedLoadoutRequest['input'],
  inherited: PiLoadout,
): boolean =>
  input.permissions !== inherited.permissions ||
  hasHarnessOverride(input) ||
  hasModelOverride(input, inherited);

const changesInheritedCwd = (
  input: InheritedLoadoutRequest['input'],
  inherited: PiLoadout,
  context: ExtensionContext,
): boolean => realpathSync(resolve(context.cwd, input.cwd ?? '.')) !== inherited.cwd;

export const resolveInheritedLoadout = async (
  request: InheritedLoadoutRequest,
): Promise<PiLoadout> => {
  const { parent, input, context, pi, signal } = request;
  const inherited = parent.loadout;

  if (!isPiLoadout(inherited)) {
    throw new Error('Non-Pi workers have no Tau nesting channel.');
  }

  const changedSettings = changesInheritedSettings(input, inherited);
  const changedCwd = changesInheritedCwd(input, inherited, context);

  if (changedSettings || changedCwd) {
    throw new Error(
      'Nested workers require the exact inherited model, permissions, harness, and cwd.',
    );
  }

  const { profile, instructions } = inheritedProfile(parent, input, context.isProjectTrusted());
  await checkWorkerRuntime(inherited, pi, context, signal);

  return {
    ...inherited,
    profile: profile.name,
    role: profile.role,
    instructions,
  };
};
