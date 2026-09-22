import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import { Value } from 'typebox/value';

import { genericLoadoutSchema } from './types.js';
import type { GenericLoadout, Profile } from './types.js';

export interface NativeLaunchInput {
  nativeArguments?: string[];
  reportDirectory?: string;
  model?: string;
  permissions: string;
}

export interface GenericLoadoutRequest {
  input: NativeLaunchInput;
  profile: Profile;
  kind: string;
  cwd: string;
  signal: AbortSignal;
}

const escapesCwd = (relativeDirectory: string): boolean =>
  isAbsolute(relativeDirectory) ||
  relativeDirectory === '..' ||
  relativeDirectory.startsWith('../');

const reportArea = (cwd: string, requested: string | undefined): string => {
  const directory = realpathSync(resolve(cwd, requested ?? '.'));
  const relativeDirectory = relative(cwd, directory);

  if (escapesCwd(relativeDirectory) || !statSync(directory).isDirectory()) {
    throw new Error(
      'The report directory must already exist inside the authorized cwd. Tau will not widen a native sandbox.',
    );
  }

  return directory;
};

const requireSupportedKind = (kind: string): void => {
  if (kind === 'pi' || kind === 'generic' || !/^[a-z][a-z0-9-]{0,63}$/.test(kind)) {
    throw new Error('Select a non-Pi herdr kind. Herdr decides which kinds are supported.');
  }
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

  requireSupportedKind(kind);

  if (profile.thinkingSpecified) {
    throw new Error(
      'Native thinking settings require explicit native arguments, not a profile setting.',
    );
  }

  const nativeArguments = [...(input.nativeArguments ?? [])];
  const requestedModel = input.model ?? profile.model;

  if (requestedModel && !nativeArguments.length) {
    throw new Error(
      'An exact model request requires corresponding native arguments. Tau does not translate or verify native model selection.',
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
    instructions: profile.instructions,
  };

  if (!Value.Check(genericLoadoutSchema, loadout) || JSON.stringify(loadout).length > 32_000) {
    throw new Error('Invalid or oversized native worker configuration.');
  }

  return loadout;
};

export const resolveGenericLoadout = (request: GenericLoadoutRequest): GenericLoadout => {
  const { input, profile, kind, cwd, signal } = request;

  signal.throwIfAborted();

  return captureConfiguration(input, profile, kind, cwd);
};
