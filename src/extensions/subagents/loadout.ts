import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import { clampThinkingLevel } from '@earendil-works/pi-ai';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
} from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';

import { inheritedInstructions } from './admission.js';
import { resolveGenericLoadout } from './genericLoadout.js';
import type { NativeLaunchInput } from './genericLoadout.js';
import { resolveProfile } from './profiles.js';
import { harnessOf, isPiLoadout, loadoutSchema, textLimit } from './types.js';
import type { Loadout, PiLoadout, Profile, Task } from './types.js';

type ModelContext = Pick<ExtensionContext, 'modelRegistry' | 'scopedModels'>;

const findModel = (registry: ModelRegistry, model: string) => {
  const separator = model.indexOf('/');

  // oxlint-disable-next-line unicorn/no-array-method-this-argument -- ModelRegistry.find takes provider and model IDs, not an array predicate.
  return registry.find(model.slice(0, separator), model.slice(separator + 1));
};

const configuredModels = (context: ModelContext): string => {
  const models = context.scopedModels.map(({ model }) => `${model.provider}/${model.id}`);

  return models.length ? ` Configured models: ${models.join(', ')}.` : '';
};

const resolveModel = (
  explicit: string | undefined,
  configured: string | undefined,
  context: ModelContext,
) => {
  // oxlint-disable-next-line node/no-process-env -- Explicit worker model configuration has no implicit parent-model fallback.
  const model = explicit ?? configured ?? process.env.TAU_SUBAGENT_MODEL;

  if (!model || !/^[^/\s]+\/[^\s]+$/.test(model)) {
    throw new Error(
      `Set an exact worker model as provider/id; there is no fallback.${configuredModels(context)}`,
    );
  }

  const selectedModel = findModel(context.modelRegistry, model);

  if (!selectedModel) {
    throw new Error(`Worker model unavailable: ${model}.${configuredModels(context)}`);
  }

  return selectedModel;
};

const piWorkerTools = (extensionTools: Iterable<string>): string[] =>
  [
    ...new Set([
      'read',
      'bash',
      'edit',
      'write',
      ...extensionTools,
      'subagent_progress',
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
    throw new Error(
      `Workers launch only in this session's cwd (${context.cwd}). For ${cwd}, send the task to the agent already running there (herdr agent list, herdr agent prompt) or start a session there.`,
    );
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

export const resolveLoadout = (
  input: NativeLaunchInput & { profile: string; cwd?: string; harness?: string },
  context: Pick<ExtensionContext, 'cwd' | 'modelRegistry' | 'scopedModels' | 'isProjectTrusted'>,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Loadout => {
  signal.throwIfAborted();
  const { cwd, agentDirectory, profile, kind } = resolveLaunchPlan(input, context);

  if (kind !== 'pi') {
    return resolveGenericLoadout({ input, profile, kind, cwd, signal });
  }

  requirePiPermissions(input);
  const model = resolveModel(input.model, profile.model, context);

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
  };
};

const requireSavedWorkerDirectory = (loadout: PiLoadout, context: { cwd: string }): void => {
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
): PiLoadout => {
  if (!Value.Check(loadoutSchema, value)) {
    throw new Error('Invalid saved worker loadout.');
  }

  if (!isPiLoadout(value)) {
    throw new Error('Non-Pi continuation is unsupported; start a fresh task.');
  }

  if (!context.isProjectTrusted()) {
    throw new Error('Saved worker replay requires a currently trusted project.');
  }

  requireSavedWorkerDirectory(value, context);
  const model = findModel(context.modelRegistry, value.model);

  if (!model || clampThinkingLevel(model, value.thinking) !== value.thinking) {
    throw new Error('Saved worker model or thinking cannot be reproduced; no fallback allowed.');
  }

  return value;
};

export const checkWorkerRuntime = (
  loadout: PiLoadout,
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

  // Pi suffixes duplicate command names. Accept those names only with extension provenance.
  const safetyActive = pi
    .getCommands()
    .some(
      (command) =>
        command.source === 'extension' && /^cc-safety-net(?::[1-9]\d*)?$/.test(command.name),
    );

  if (!safetyActive) {
    throw new Error(
      'CC Safety Net must be loaded in the worker; install it in the saved Pi configuration.',
    );
  }

  pi.setActiveTools(
    piWorkerTools(
      pi
        .getAllTools()
        .filter(
          (tool: { sourceInfo?: { source?: string } }) => tool.sourceInfo?.source !== 'builtin',
        )
        .map((tool) => tool.name),
    ),
  );
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

export const resolveInheritedLoadout = (request: InheritedLoadoutRequest): PiLoadout => {
  const { parent, input, context, pi } = request;
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
  checkWorkerRuntime(inherited, pi, context);

  return {
    ...inherited,
    profile: profile.name,
    role: profile.role,
    instructions,
  };
};
