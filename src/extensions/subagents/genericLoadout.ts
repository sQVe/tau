import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Value } from 'typebox/value';

import { genericLoadoutSchema } from './types.js';
import type { GenericLoadout, Profile } from './types.js';

export interface NativeLaunchInput {
  nativeArguments?: string[];
  reportDirectory?: string;
  model?: string;
  permissions: string;
}

const reportArea = (cwd: string, requested: string | undefined): string => {
  const directory = realpathSync(resolve(cwd, requested ?? '.'));
  const relativeDirectory = relative(cwd, directory);

  if (
    isAbsolute(relativeDirectory) ||
    relativeDirectory === '..' ||
    relativeDirectory.startsWith('../') ||
    !statSync(directory).isDirectory()
  ) {
    throw new Error(
      'The report directory must already exist inside the authorized cwd. Tau will not widen a native sandbox.',
    );
  }

  return directory;
};

const captureConfiguration = (
  input: NativeLaunchInput,
  profile: Profile,
  kind: string,
  cwd: string,
): GenericLoadout => {
  if (input.permissions !== 'native-controls') {
    throw new Error(
      'Non-Pi workers require native-controls. Tau cannot certify their safety integration or runtime permissions.',
    );
  }

  if (kind === 'pi' || kind === 'generic' || !/^[a-z][a-z0-9-]{0,63}$/.test(kind)) {
    throw new Error('Select a non-Pi herdr kind. Herdr decides which kinds are supported.');
  }

  if (profile.thinkingSpecified) {
    throw new Error(
      'Native thinking settings require user-approved native arguments, not a profile setting.',
    );
  }

  const nativeArguments = [...(input.nativeArguments ?? [])];
  const requestedModel = input.model ?? profile.model;

  if (requestedModel && !nativeArguments.length) {
    throw new Error(
      'An exact model request requires corresponding user-approved native arguments. Tau does not translate or verify native model selection.',
    );
  }

  const loadout = {
    harness: 'generic' as const,
    kind,
    profile: profile.name,
    role: profile.role,
    cwd,
    permissions: 'native-controls' as const,
    arguments: nativeArguments,
    ...(requestedModel === undefined ? {} : { requestedModel }),
    reportDirectory: reportArea(cwd, input.reportDirectory),
    configurationApproved: true as const,
    instructions: profile.instructions,
  };

  if (!Value.Check(genericLoadoutSchema, loadout) || JSON.stringify(loadout).length > 32_000) {
    throw new Error('Invalid or oversized native worker configuration.');
  }

  return loadout;
};

export const resolveGenericLoadout = async (
  input: NativeLaunchInput,
  profile: Profile,
  kind: string,
  cwd: string,
  context: Partial<Pick<ExtensionContext, 'hasUI' | 'ui'>>,
  signal: AbortSignal,
): Promise<GenericLoadout> => {
  signal.throwIfAborted();
  const loadout = captureConfiguration(input, profile, kind, cwd);

  if (!context.hasUI || !context.ui) {
    throw new Error(
      'Native configuration needs explicit user confirmation in the parent UI. No unattended approval is inferred from tool calls.',
    );
  }

  const approved = await context.ui.confirm(
    'Approve native worker configuration?',
    `Kind: ${kind}\nCwd: ${cwd}\nArguments (literal list): ${JSON.stringify(loadout.arguments)}\n${loadout.requestedModel ? `Requested model: ${loadout.requestedModel}. Confirm these arguments select it; Tau cannot verify which model runs.` : 'No model requested. The harness selects its configured model.'}\nReport area: ${loadout.reportDirectory}. Confirm it is already authorized and writable for this worker. Tau will create a unique report directory here.\nTau does not certify native safety controls. Existing integrations and approval dialogs remain in force. This approval does not answer later native dialogs or authorize wider scope.`,
    { signal },
  );
  signal.throwIfAborted();

  if (!approved) {
    throw new Error('Native worker configuration was not approved.');
  }

  return loadout;
};
