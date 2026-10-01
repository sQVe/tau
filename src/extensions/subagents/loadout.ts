import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
  SlashCommandInfo,
} from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';

import { parseModelReference, readAllowedModels, requireAllowedModel } from '../../models/index.js';
import { userConfigPath } from '../../tauConfig/index.js';
import type { ConfigLocation } from '../../tauConfig/index.js';
import { readProfileModels } from './profileModels.js';
import { resolveProfile, workerTools } from './profiles.js';
import { loadoutSchema } from './types.js';
import type { Loadout, Profile } from './types.js';
import { availableModels, selectWorkerModel } from './workerModels.js';

type ModelContext = Pick<ExtensionContext, 'modelRegistry' | 'scopedModels'>;

interface LaunchRequest {
  profile: string;
  cwd?: string;
  model?: string;
}

const nodeRequire = createRequire(import.meta.url);

// Tau's package loads this file; the worker accepts no other extension under the Safety Net name.
const safetyExtension = (): string =>
  realpathSync(
    join(dirname(nodeRequire.resolve('cc-safety-net/package.json')), 'dist', 'pi', 'index.js'),
  );

const findModel = (
  registry: ModelRegistry,
  location: ConfigLocation,
  model: { provider: string; id: string },
) => {
  requireAllowedModel(`${model.provider}/${model.id}`, location);

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  return registry.find(model.provider, model.id);
};

const scopedModelReferences = (context: Pick<ExtensionContext, 'scopedModels'>): string[] =>
  context.scopedModels.map(({ model }) => `${model.provider}/${model.id}`);

// The scoped models a launch may pass, as the launch description and errors list them.
export const launchModels = (
  context: Pick<ExtensionContext, 'scopedModels'>,
  location: ConfigLocation,
): string[] => availableModels(scopedModelReferences(context), readAllowedModels(location)?.models);

const configuredModels = (context: ModelContext, location: ConfigLocation): string => {
  const models = launchModels(context, location);

  return models.length > 0 ? ` Configured models: ${models.join(', ')}.` : '';
};

const resolveModel = (
  explicit: string | undefined,
  profile: Profile,
  context: ModelContext,
  location: ConfigLocation,
) => {
  const model = selectWorkerModel(explicit, profile.name, readProfileModels(location));

  if (model === undefined) {
    throw new Error(
      `No model for worker profile ${profile.name}. Pass model, or set profiles.default.model in ${userConfigPath(location.agentDirectory)}.${configuredModels(context, location)}`,
    );
  }

  const reference = parseModelReference(model);

  if (!reference) {
    throw new Error(
      `Set an exact worker model as provider/id; there is no fallback.${configuredModels(context, location)}`,
    );
  }

  const selectedModel = findModel(context.modelRegistry, location, reference);

  if (!selectedModel) {
    throw new Error(`Worker model unavailable: ${model}.${configuredModels(context, location)}`);
  }

  return selectedModel;
};

const resolveSkills = (profile: Profile, commands: SlashCommandInfo[]): string[] =>
  profile.skills.map((name) => {
    const skill = commands.find(
      (command) => command.source === 'skill' && command.name === `skill:${name}`,
    );

    if (!skill) {
      throw new Error(`Worker profile skill not found: ${name}`);
    }

    return skill.sourceInfo.path;
  });

const resolveLaunchPlan = (
  input: LaunchRequest,
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
) => {
  if (!context.isProjectTrusted()) {
    throw new Error('Worker launch requires a trusted project.');
  }

  const cwd = realpathSync(resolve(context.cwd, input.cwd ?? '.'));

  // A different project needs its own trust decision, not the parent's inherited approval.
  if (cwd !== realpathSync(context.cwd)) {
    throw new Error(
      `Workers launch only in this session's cwd (${context.cwd}). For ${cwd}, send the task to the agent already running there (herdr agent list, herdr agent prompt) or start a session there.`,
    );
  }

  const agentDirectory = realpathSync(getAgentDir());
  const profile = resolveProfile(cwd, agentDirectory, true, input.profile);

  if (!profile) {
    throw new Error(`Worker profile not found: ${input.profile}`);
  }

  return { cwd, agentDirectory, profile };
};

export const resolveLoadout = (
  input: LaunchRequest,
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'scopedModels' | 'isProjectTrusted'>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
  commands: SlashCommandInfo[] = [],
): Loadout => {
  signal.throwIfAborted();
  const { cwd, agentDirectory, profile } = resolveLaunchPlan(input, context);
  // The launch plan already requires a trusted project.
  const location = { cwd, agentDirectory, projectTrusted: true };
  const model = resolveModel(input.model, profile, context, location);

  return {
    harness: 'pi',
    profile: profile.name,
    role: profile.role,
    model: `${model.provider}/${model.id}`,
    thinking: clampThinkingLevel(model, profile.thinking),
    cwd,
    agentDirectory,
    permissions: 'trusted-full-tools',
    instructions: profile.instructions,
    tools: profile.tools,
    skills: resolveSkills(profile, commands),
    instructionSets: profile.instructionSets,
    packages: profile.packages,
  };
};

const requireSavedWorkerDirectory = (loadout: Loadout, context: { cwd: string }): void => {
  if (
    realpathSync(context.cwd) !== loadout.cwd ||
    realpathSync(getAgentDir()) !== loadout.agentDirectory
  ) {
    throw new Error('Worker cwd or configuration directory changed.');
  }
};

export const validateSavedLoadout = (
  value: unknown,
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'isProjectTrusted'>,
): Loadout => {
  if (!Value.Check(loadoutSchema, value)) {
    throw new Error('Invalid saved worker loadout.');
  }

  if (!context.isProjectTrusted()) {
    throw new Error('Saved worker replay requires a currently trusted project.');
  }

  requireSavedWorkerDirectory(value, context);
  const reference = parseModelReference(value.model);
  const location = { cwd: value.cwd, agentDirectory: value.agentDirectory, projectTrusted: true };
  const model = reference && findModel(context.modelRegistry, location, reference);

  if (!model || clampThinkingLevel(model, value.thinking) !== value.thinking) {
    throw new Error('Saved worker model or thinking cannot be reproduced; no fallback allowed.');
  }

  const missingSkill = value.skills.find((path) => !existsSync(path));

  if (missingSkill !== undefined) {
    throw new Error(`Saved worker skill is missing: ${missingSkill}`);
  }

  return value;
};

export const checkWorkerRuntime = (
  loadout: Loadout,
  pi: Pick<ExtensionAPI, 'getThinkingLevel' | 'getCommands' | 'getAllTools' | 'setActiveTools'>,
  context: Pick<ExtensionContext, 'model' | 'cwd' | 'isProjectTrusted'>,
): void => {
  if (!context.isProjectTrusted()) {
    throw new Error('Worker project trust was refused.');
  }

  const model = context.model;

  if (
    !model ||
    `${model.provider}/${model.id}` !== loadout.model ||
    pi.getThinkingLevel() !== loadout.thinking
  ) {
    throw new Error(
      'Worker model or thinking differs from the saved loadout; no fallback allowed.',
    );
  }

  requireSavedWorkerDirectory(loadout, context);

  // Pi suffixes duplicate command names. Accept those names only from the bundled Safety Net file.
  const expectedSafety = safetyExtension();

  const safetyActive = pi
    .getCommands()
    .some(
      (command) =>
        command.source === 'extension' &&
        /^cc-safety-net(?::[1-9]\d*)?$/.test(command.name) &&
        realpathSync(command.sourceInfo.path) === expectedSafety,
    );

  if (!safetyActive) {
    throw new Error(
      'CC Safety Net must be loaded in the worker; install it in the saved Pi configuration.',
    );
  }

  // Pi's --tools skips unknown names without an error.
  const registered = new Set(pi.getAllTools().map((tool) => tool.name));
  const tools = workerTools(loadout);
  const missing = tools.filter((tool) => !registered.has(tool));

  if (missing.length > 0) {
    throw new Error(`Worker profile tools are not registered: ${missing.join(', ')}.`);
  }

  pi.setActiveTools(tools);
};
