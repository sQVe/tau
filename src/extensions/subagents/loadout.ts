import { realpathSync } from 'node:fs';
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

import { userConfigPath } from '../../config/config.js';
import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import {
  parseModelReference,
  readAllowedModels,
  requireAllowedModel,
} from '../../config/models.js';
import { acceptanceRefusal } from './acceptanceRefusal.js';
import { pickRoutedModel } from './modelRoutes.js';
import type { RoutedLaunch } from './modelRoutes.js';
import { readProfileModel, readProfileRoute } from './profileModels.js';
import { resolveProfile } from './profiles.js';
import { classifierAllowed, classifyRoute } from './routeClassifier.js';
import type { Classification } from './routeClassifier.js';
import type { Loadout, Profile } from './types.js';
import { availableModels, defaultProfileName } from './workerModels.js';

type ModelContext = Pick<ExtensionContext, 'modelRegistry' | 'scopedModels'> & {
  ui: ConfigWarnings;
};

interface LaunchRequest {
  profile: string;
  cwd?: string;
  model?: string;
  acceptance?: string[];
}

export interface RoutedLoadout {
  loadout: Loadout;
  routing: RoutedLaunch | undefined;
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
  const profileModel = readProfileModel(location, profile.name, context.ui);

  const model =
    explicit ?? profileModel ?? readProfileModel(location, defaultProfileName, context.ui);

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

export const requireTrustedProject = (
  context: Pick<ExtensionContext, 'isProjectTrusted'>,
): void => {
  if (!context.isProjectTrusted()) {
    throw new Error('Worker launch requires a trusted project.');
  }
};

// A different project needs its own trust decision, not the parent's inherited approval.
export const requireSessionCwd = (
  context: Pick<ExtensionContext, 'cwd'>,
  requested?: string,
): string => {
  const cwd = realpathSync(resolve(context.cwd, requested ?? '.'));

  if (cwd !== realpathSync(context.cwd)) {
    throw new Error(
      `Workers launch only in this session's cwd (${context.cwd}). For ${cwd}, send the task to the agent already running there with the handover skill or start a session there.`,
    );
  }

  return cwd;
};

const resolveLaunchPlan = (
  input: LaunchRequest,
  context: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>,
) => {
  requireTrustedProject(context);

  const cwd = requireSessionCwd(context, input.cwd);

  const agentDirectory = realpathSync(getAgentDir());
  const profile = resolveProfile(cwd, agentDirectory, true, input.profile);

  if (!profile) {
    throw new Error(`Worker profile not found: ${input.profile}`);
  }

  return { cwd, agentDirectory, profile };
};

export const resolveLoadout = (
  input: LaunchRequest,
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'scopedModels' | 'isProjectTrusted'> & {
    ui: ConfigWarnings;
  },
  commands: SlashCommandInfo[] = [],
): Loadout => {
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

export const resolveRoutedLoadout = async (
  input: LaunchRequest & { task: string },
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'scopedModels' | 'isProjectTrusted'> & {
    ui: ConfigWarnings;
  },
  commands: SlashCommandInfo[] = [],
  signal?: AbortSignal,
): Promise<RoutedLoadout> => {
  const loadout = resolveLoadout(input, context, commands);
  const refusal = acceptanceRefusal(loadout.role, input.acceptance);

  if (refusal !== undefined) {
    throw new Error(refusal);
  }

  if (input.model !== undefined) {
    return { loadout, routing: undefined };
  }

  const location = {
    cwd: loadout.cwd,
    agentDirectory: loadout.agentDirectory,
    projectTrusted: true,
  };

  const route = readProfileRoute(location, loadout.profile, context.ui);

  if (route === undefined) {
    return { loadout, routing: undefined };
  }

  const { outcome, ticketSent }: Classification = classifierAllowed(location, route)
    ? await classifyRoute(
        context,
        route,
        { brief: input.task, profile: loadout.profile, cwd: loadout.cwd },
        signal,
      )
    : { outcome: { kind: 'skipped' }, ticketSent: false };

  const pick = pickRoutedModel({
    launchModel: input.model,
    profileModel: loadout.model,
    route,
    outcome,
  });

  if (pick === undefined) {
    return { loadout, routing: undefined };
  }

  const routing = { ...pick, ticketSent };

  if (pick.shadowPick === loadout.model) {
    return { loadout, routing };
  }

  // The routed model passes the same checks as an explicit launch model.
  const routedLoadout = resolveLoadout({ ...input, model: pick.shadowPick }, context, commands);

  return { loadout: routedLoadout, routing };
};

const requireSavedWorkerDirectory = (loadout: Loadout, context: { cwd: string }): void => {
  if (
    realpathSync(context.cwd) !== loadout.cwd ||
    realpathSync(getAgentDir()) !== loadout.agentDirectory
  ) {
    throw new Error('Worker cwd or configuration directory changed.');
  }
};

export const checkWorkerRuntime = (
  loadout: Loadout,
  pi: Pick<ExtensionAPI, 'getThinkingLevel' | 'getCommands' | 'getAllTools' | 'setActiveTools'>,
  context: Pick<ExtensionContext, 'model' | 'cwd' | 'isProjectTrusted'>,
  tools: string[],
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
  const missing = tools.filter((tool) => !registered.has(tool));

  if (missing.length > 0) {
    throw new Error(`Worker profile tools are not registered: ${missing.join(', ')}.`);
  }

  pi.setActiveTools(tools);
};
