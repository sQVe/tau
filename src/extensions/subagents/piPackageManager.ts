import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';

import type { WorkerPackageManager } from './packageInstall.js';
import type { Loadout } from './types.js';

// Build Pi's package manager as the worker will: in its cwd and agent directory, with the project
// trusted.
export const piPackageManager = (loadout: Loadout): WorkerPackageManager => {
  const settingsManager = SettingsManager.create(loadout.cwd, loadout.agentDirectory, {
    projectTrusted: true,
  });

  return new DefaultPackageManager({
    cwd: loadout.cwd,
    agentDir: loadout.agentDirectory,
    settingsManager,
  });
};
