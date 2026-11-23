import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type { ConfigLocation, ConfigWarnings } from '../../config/config.js';
import { notifyOnce, userConfigPath } from '../../config/config.js';
import { errorMessage } from '../../errors.js';

export interface GateConfigCandidate<Config> {
  config: Config;
  models: readonly string[];
}

export interface GateConfigRequest {
  cwd: string;
  projectTrusted: boolean;
  ui: ConfigWarnings;
}

const reportRefusal = (ui: ConfigWarnings, location: ConfigLocation, error: unknown): void => {
  const message = errorMessage(error);

  try {
    notifyOnce(ui, userConfigPath(location.agentDirectory), message, message, 'error');
  } catch {
    // A notice that cannot be shown must not stop the dialog fallback.
  }
};

export const readAllowedGateConfig = <Config>(
  request: GateConfigRequest,
  read: (location: ConfigLocation) => GateConfigCandidate<Config> | undefined,
  requireModel: (reference: string, location: ConfigLocation) => void,
): Config | undefined => {
  const location: ConfigLocation = {
    cwd: request.cwd,
    agentDirectory: getAgentDir(),
    projectTrusted: request.projectTrusted,
  };

  try {
    const candidate = read(location);

    if (candidate === undefined) {
      return undefined;
    }

    for (const reference of candidate.models) {
      requireModel(reference, location);
    }

    return candidate.config;
  } catch (error) {
    reportRefusal(request.ui, location, error);

    return undefined;
  }
};
