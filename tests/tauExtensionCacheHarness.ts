import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

// Pi loads Tau through jiti, which transforms every Tau source file with Babel and caches the
// result on disk. A cold cache makes the first Tau load in a run take seconds longer, and test
// workers contend for the CPU. Loading Tau once here, with Pi's own loader so the cache keys match,
// keeps that cost outside every test timeout.
export default async function setup(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'tau-extension-cache-'));

  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: join(directory, 'agent'),
      settingsManager: SettingsManager.inMemory(),
      additionalExtensionPaths: [join(import.meta.dirname, '..', 'src', 'tau.ts')],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });

    await loader.reload();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
