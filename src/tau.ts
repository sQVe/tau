import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type { SourceRegistration } from './tau/tauSelection.js';
import { loadTauRegistration } from './tau/tauSelection.js';

export type { TauRegistration } from './tau/tauSelection.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const sourceRegistration: SourceRegistration = async () => {
  const module = await import('./tau/tau.js');

  return module.default;
};

export default async function tauExtension(pi: ExtensionAPI): Promise<void> {
  await loadTauRegistration(pi, packageRoot, sourceRegistration);
}
