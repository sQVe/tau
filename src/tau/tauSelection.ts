import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readTauArtifactKey, tauArtifactPath } from './tauArtifact.js';

export type TauRegistration = (pi: ExtensionAPI) => Promise<void>;

// The entry owns the only edge to the registration owner, so it passes the fallback in.
export type SourceRegistration = () => Promise<TauRegistration>;

interface TauRegistrationModule {
  default: TauRegistration;
}

export const isTauRegistrationModule = (value: unknown): value is TauRegistrationModule => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('default' in value)) {
    return false;
  }

  return typeof value.default === 'function';
};

// A missing or unreadable artifact falls back to the source factory. A matching artifact that fails
// to import or initialize reports that error and never runs the source factory as well.
export const resolveTauRegistration = async (
  root: string,
  sourceRegistration: SourceRegistration,
): Promise<TauRegistration> => {
  const key = await readTauArtifactKey(root).catch(() => undefined);

  if (key === undefined) {
    return sourceRegistration();
  }

  const artifact = tauArtifactPath(root, key);

  if (!existsSync(artifact)) {
    return sourceRegistration();
  }

  const module: unknown = await import(pathToFileURL(artifact).href);

  if (!isTauRegistrationModule(module)) {
    throw new Error('The Tau artifact has no default registration.');
  }

  return module.default;
};

export const loadTauRegistration = async (
  pi: ExtensionAPI,
  root: string,
  sourceRegistration: SourceRegistration,
): Promise<void> => {
  const registration = await resolveTauRegistration(root, sourceRegistration);

  await registration(pi);
};
