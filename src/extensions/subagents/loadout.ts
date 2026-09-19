import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { clampThinkingLevel } from '@earendil-works/pi-ai';
import {
  DefaultResourceLoader,
  ModelRuntime,
  ModelRegistry,
  parseArgs,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { inheritedInstructions } from './admission.js';
import {
  channelScriptPath,
  claudeBuiltinTools,
  claudeChannelTools,
  claudeEffort,
  claudeToolName,
  claudeVersion,
  probeSafetyIntegration,
  resolveClaudeSafetyPlugin,
} from './claude.js';
import { resolveProfile } from './profiles.js';
import { harnessOf, isClaudeLoadout, loadoutSchema, textLimit } from './types.js';
import type { ClaudeLoadout, Loadout, PiLoadout, Task } from './types.js';

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

// Claude's settings candidates are fingerprinted whether they exist or not: creating one changes
// what the worker loads just as editing one does.
export const claudeIntegrationFingerprint = (paths: string[]): string =>
  modelFingerprint(
    paths.map((path) => ({ path, digest: existsSync(path) ? fileDigest(path) : 'absent' })),
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
  signal.throwIfAborted();
  if (!auth.ok) {
    throw new Error('Selected worker provider authentication is unavailable.');
  }
  const registration = registry.getRegisteredProviderConfig(model.provider);
  const native = registry.getRegisteredNativeProvider(model.provider);

  return { baseUrl: provider.baseUrl, headers: provider.headers, auth, registration, native };
};

const providerFingerprintValue = (
  configuration: Awaited<ReturnType<typeof providerConfiguration>>,
  version: 1 | 2,
): string => {
  if (version === 1) {
    return modelFingerprint(configuration);
  }
  const { apiKey: _resolvedKey, ...auth } = configuration.auth;
  let modelsConfiguration: string | null = null;
  try {
    modelsConfiguration = createHash('sha256')
      .update(readFileSync(join(getAgentDir(), 'models.json')))
      .digest('hex');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
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
  version: 1 | 2 = 1,
): Promise<string> => {
  const configuration = await providerConfiguration(registry, model, signal);
  // Pi distributions can minify SDK wrappers differently. Compare implementations in the parent process, not across processes.
  return providerFingerprintValue(configuration, version);
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

const checkProviderConfiguration = (
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

  if (registry.getError()) {
    throw new Error('Worker model configuration could not be reconstructed.');
  }

  return { loaded, registry, safety };
};

const claudeConfigDirectory = (): string =>
  // oxlint-disable-next-line node/no-process-env -- Claude Code reads this same variable to find its configuration.
  realpathSync(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));

const managedSettingsPath = (): string =>
  process.platform === 'darwin'
    ? '/Library/Application Support/ClaudeCode/managed-settings.json'
    : '/etc/claude-code/managed-settings.json';

// Claude merges user, project, and local settings, and managed settings win over all of them.
// Every candidate is recorded, present or not. Claude reads whichever exist when it starts, so a
// file that appears after resolution must change the fingerprint rather than escape it.
const claudeSettingsSources = (agentDirectory: string, cwd: string): string[] => [
  join(agentDirectory, 'settings.json'),
  join(cwd, '.claude', 'settings.json'),
  join(cwd, '.claude', 'settings.local.json'),
  managedSettingsPath(),
];

const claudeSettingsSchema = Type.Object({
  permissions: Type.Optional(Type.Object({ defaultMode: Type.Optional(Type.String()) })),
  skipDangerousModePermissionPrompt: Type.Optional(Type.Boolean()),
  enabledPlugins: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
});

const claudeSettings = (sources: string[]) => {
  const merged = { mode: undefined as string | undefined, skipPrompt: false };
  // A later source turns a plugin off as well as on, so track the last value rather than the union.
  const enabled = new Map<string, boolean>();

  for (const path of sources.filter((candidate) => existsSync(candidate))) {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Value.Check(claudeSettingsSchema, parsed)) {
      throw new Error(`Claude settings at ${path} are unusable for a worker launch.`);
    }

    merged.mode = parsed.permissions?.defaultMode ?? merged.mode;
    merged.skipPrompt = parsed.skipDangerousModePermissionPrompt ?? merged.skipPrompt;

    for (const [name, active] of Object.entries(parsed.enabledPlugins ?? {})) {
      enabled.set(name, active);
    }
  }

  return {
    ...merged,
    plugins: [...enabled].filter(([, active]) => active).map(([name]) => name),
  };
};

const resolveExecutable = (name: string): string => {
  // oxlint-disable-next-line node/no-process-env -- The canonical executable comes from this process's PATH, not the worker pane's interactive shell.
  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(entry, name);
    try {
      accessSync(candidate, constants.X_OK);

      return realpathSync(candidate);
    } catch {
      // Keep searching; an unreadable or missing entry is not the executable.
    }
  }

  throw new Error(`Claude workers need ${name} on PATH.`);
};

// Require saved permissions instead of granting them through a launch flag.
const requireClaudePermissions = (settings: ReturnType<typeof claudeSettings>): void => {
  if (settings.mode !== 'bypassPermissions') {
    throw new Error(
      `Claude workers need saved permission mode bypassPermissions for trusted-full-tools; this configuration resolves to ${settings.mode ?? 'default'}. Tau refuses rather than pass a permission flag.`,
    );
  }
  if (!settings.skipPrompt) {
    throw new Error(
      'Claude would open its bypass-permissions confirmation at startup, which no worker can answer. Set skipDangerousModePermissionPrompt in your Claude settings first.',
    );
  }
};

const claudeIntegrations = (
  sources: string[],
  plugin: ReturnType<typeof resolveClaudeSafetyPlugin>,
  channelScript: string,
): string[] => [
  ...new Set(
    [...sources, plugin.hooksPath, plugin.entry, channelScript].map((path) =>
      existsSync(path) ? realpathSync(path) : path,
    ),
  ),
];

const claudeProfile = (cwd: string, trusted: boolean, name: string) => {
  const profile = resolveProfile(cwd, realpathSync(getAgentDir()), trusted, name);
  if (!profile) {
    throw new Error(`Worker profile not found: ${name}`);
  }
  if (profile.harnessSpecified && profile.harness !== 'claude') {
    throw new Error(`Profile ${profile.name} is a ${profile.harness} profile, not a Claude one.`);
  }

  return profile;
};

export const resolveClaudeLoadout = async (
  input: { profile: string; cwd?: string; model?: string; permissions: string },
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<ClaudeLoadout> => {
  signal.throwIfAborted();

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

  const agentDirectory = claudeConfigDirectory();
  const profile = claudeProfile(cwd, true, input.profile);
  const model = input.model ?? profile.model;
  if (!model || /\s/.test(model)) {
    throw new Error(
      'Set an exact Claude model for this worker, such as claude-sonnet-5. There is no fallback.',
    );
  }

  const sources = claudeSettingsSources(agentDirectory, cwd);
  const settings = claudeSettings(sources);
  requireClaudePermissions(settings);

  const plugin = resolveClaudeSafetyPlugin(agentDirectory, settings.plugins);
  const executable = resolveExecutable('claude');
  const channelScript = realpathSync(channelScriptPath());

  const loadout: ClaudeLoadout = {
    harness: 'claude',
    profile: profile.name,
    role: profile.role,
    model,
    executable,
    executableVersion: await claudeVersion(executable),
    thinking: profile.thinking,
    cwd,
    agentDirectory,
    permissions: 'trusted-full-tools',
    permissionMode: 'bypassPermissions',
    channelExecutable: process.execPath,
    channelScript,
    tools: [...claudeBuiltinTools, ...claudeChannelTools.map((tool) => claudeToolName(tool))],
    integrations: claudeIntegrations(sources, plugin, channelScript),
    integrationFingerprint: '',
    safetyExtension: plugin.entry,
    safetyArguments: plugin.arguments,
    instructions: profile.instructions,
  };

  claudeEffort(loadout.thinking);
  await probeSafetyIntegration(loadout);
  signal.throwIfAborted();

  return {
    ...loadout,
    integrationFingerprint: claudeIntegrationFingerprint(loadout.integrations),
  };
};

export const validateSavedClaudeLoadout = async (
  loadout: ClaudeLoadout,
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
): Promise<ClaudeLoadout> => {
  if (!context.isProjectTrusted()) {
    throw new Error('Saved worker replay requires a currently trusted project.');
  }
  if (
    realpathSync(context.cwd) !== loadout.cwd ||
    claudeConfigDirectory() !== loadout.agentDirectory
  ) {
    throw new Error('Worker cwd or configuration directory changed.');
  }

  const sources = claudeSettingsSources(loadout.agentDirectory, loadout.cwd);
  const settings = claudeSettings(sources);
  requireClaudePermissions(settings);

  const plugin = resolveClaudeSafetyPlugin(loadout.agentDirectory, settings.plugins);
  const integrations = claudeIntegrations(sources, plugin, loadout.channelScript);
  if (
    modelFingerprint(integrations) !== modelFingerprint(loadout.integrations) ||
    plugin.entry !== loadout.safetyExtension ||
    modelFingerprint(plugin.arguments) !== modelFingerprint(loadout.safetyArguments) ||
    claudeIntegrationFingerprint(loadout.integrations) !== loadout.integrationFingerprint
  ) {
    throw new Error(
      'Saved Claude settings, safety plugin, or channel changed. A changed configuration requires a fresh task.',
    );
  }

  const executable = resolveExecutable('claude');
  if (executable !== loadout.executable) {
    throw new Error('The saved Claude executable is no longer the one on PATH.');
  }
  const executableVersion = await claudeVersion(executable);
  if (executableVersion !== loadout.executableVersion) {
    throw new Error('Claude Code was updated after this task was saved; start a fresh task.');
  }

  await probeSafetyIntegration(loadout);

  return loadout;
};

export const resolveLoadout = async (
  input: { profile: string; cwd?: string; model?: string; harness?: string; permissions: string },
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>,
  pi: Pick<ExtensionAPI, 'getAllTools' | 'getCommands'>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<Loadout> => {
  signal.throwIfAborted();

  if (!['pi', 'claude', undefined].includes(input.harness)) {
    throw new Error('Only Pi and Claude Code workers are supported.');
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
  const profile = resolveProfile(cwd, agentDirectory, true, input.profile);
  if (!profile) {
    throw new Error(`Worker profile not found: ${input.profile}`);
  }
  if ((input.harness ?? profile.harness) === 'claude') {
    return resolveClaudeLoadout(input, context, signal);
  }
  if (profile.harnessSpecified && profile.harness !== 'pi') {
    throw new Error(`Profile ${profile.name} is a ${profile.harness} profile, not a Pi one.`);
  }

  const model = resolveModel(input.model, profile.model, context.modelRegistry);
  const separator = model.indexOf('/');
  const selection = parentExtensionPaths(pi);
  const { loaded, registry, safety } = await reconstructIntegrations(
    cwd,
    agentDirectory,
    selection,
    signal,
  );
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
      'subagent_question',
    ]),
  ].filter((tool) => tool !== 'ask_user_question');

  return {
    profile: profile.name,
    role: profile.role,
    model,
    modelFingerprint: modelFingerprint(resolvedModel),
    providerFingerprint: providerFingerprintValue(reconstructedConfiguration, 2),
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
): Loadout => {
  if (!Value.Check(loadoutSchema, value)) {
    throw new Error('Invalid saved worker loadout.');
  }
  const loadout = value;
  if (!context.isProjectTrusted()) {
    throw new Error('Saved worker replay requires a currently trusted project.');
  }
  if (
    realpathSync(context.cwd) !== loadout.cwd ||
    (!isClaudeLoadout(loadout) && realpathSync(getAgentDir()) !== loadout.agentDirectory)
  ) {
    throw new Error('Worker cwd or configuration directory changed.');
  }
  const fingerprint = isClaudeLoadout(loadout)
    ? claudeIntegrationFingerprint
    : integrationFingerprint;
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
): Promise<Loadout> => {
  signal.throwIfAborted();
  const loadout = validateSavedLoadoutShape(value, context);
  if (isClaudeLoadout(loadout)) {
    return validateSavedClaudeLoadout(loadout, context);
  }

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
  const tools = new Set([
    'read',
    'bash',
    'edit',
    'write',
    'subagent_report',
    'subagent_question',
    ...loaded.extensions.flatMap((extension) => Array.from(extension.tools.keys())),
  ]);
  if (
    loadout.tools.some((tool) => !tools.has(tool)) ||
    !['read', 'bash', 'edit', 'write', 'subagent_report'].every((tool) =>
      loadout.tools.includes(tool),
    )
  ) {
    throw new Error('Saved worker tools are unavailable.');
  }

  const separator = loadout.model.indexOf('/');
  const provider = loadout.model.slice(0, separator);
  const modelId = loadout.model.slice(separator + 1);
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  const model = registry.find(provider, modelId);
  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  const currentModel = context.modelRegistry.find(provider, modelId);
  if (
    !model ||
    !currentModel ||
    modelFingerprint(model) !== loadout.modelFingerprint ||
    modelFingerprint(currentModel) !== loadout.modelFingerprint ||
    clampThinkingLevel(model, loadout.thinking) !== loadout.thinking
  ) {
    throw new Error('Saved worker model or thinking cannot be reproduced; no fallback allowed.');
  }

  const configuration = await providerConfiguration(registry, model, signal);
  const currentConfiguration = await providerConfiguration(
    context.modelRegistry,
    currentModel,
    signal,
  );
  const version = loadout.providerFingerprintVersion ?? 1;
  checkProviderConfiguration(currentConfiguration, configuration);
  if (providerFingerprintValue(configuration, version) !== loadout.providerFingerprint) {
    throw new Error(
      'Worker provider configuration differs from the saved loadout. Legacy credential changes and changed auth headers require a fresh task.',
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
    refreshOnCreate: false,
    signal,
  });
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
  const configuration = await checkLiveProviderConfiguration(context.modelRegistry, model, signal);
  if (
    providerFingerprintValue(configuration, loadout.providerFingerprintVersion ?? 1) !==
    loadout.providerFingerprint
  ) {
    throw new Error(
      'Worker provider configuration differs from the saved loadout. Legacy credential changes and changed auth headers require a fresh task.',
    );
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

const inheritedProfile = (parent: Task, input: { profile: string }, trusted: boolean) => {
  const profile = resolveProfile(
    parent.loadout.cwd,
    isClaudeLoadout(parent.loadout) ? realpathSync(getAgentDir()) : parent.loadout.agentDirectory,
    trusted,
    input.profile,
  );
  if (
    !profile ||
    (profile.harnessSpecified && profile.harness !== harnessOf(parent.loadout)) ||
    (profile.model !== undefined && profile.model !== parent.loadout.model) ||
    (profile.thinkingSpecified && profile.thinking !== parent.loadout.thinking)
  ) {
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

export const resolveInheritedClaudeLoadout = async (
  parent: Task,
  inherited: ClaudeLoadout,
  input: { profile: string; cwd?: string; model?: string; harness?: string; permissions: string },
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
): Promise<ClaudeLoadout> => {
  if (
    input.permissions !== inherited.permissions ||
    (input.harness !== undefined && input.harness !== 'claude') ||
    (input.model !== undefined && input.model !== inherited.model) ||
    realpathSync(resolve(context.cwd, input.cwd ?? '.')) !== inherited.cwd
  ) {
    throw new Error(
      'Nested workers require the exact inherited model, permissions, harness, and cwd.',
    );
  }

  const { profile, instructions } = inheritedProfile(parent, input, context.isProjectTrusted());
  await validateSavedClaudeLoadout(inherited, context);

  return { ...inherited, profile: profile.name, role: profile.role, instructions };
};

export const resolveInheritedLoadout = async (
  parent: Task,
  input: { profile: string; cwd?: string; model?: string; harness?: string; permissions: string },
  context: ExtensionContext,
  pi: ExtensionAPI,
  signal: AbortSignal,
): Promise<Loadout> => {
  const inherited = parent.loadout;
  if (isClaudeLoadout(inherited)) {
    return resolveInheritedClaudeLoadout(parent, inherited, input, context);
  }
  if (
    input.permissions !== inherited.permissions ||
    (input.harness !== undefined && input.harness !== 'pi') ||
    (input.model !== undefined && input.model !== inherited.model) ||
    realpathSync(resolve(context.cwd, input.cwd ?? '.')) !== inherited.cwd
  ) {
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
