import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { notifyOnce, userConfigPath } from '../../config/config.js';
import type { ConfigWarnings } from '../../config/config.js';
import type { FallbackModelsRead } from './fallbackConfig.js';

export const reportFallbackModels = (ui: ConfigWarnings, read: FallbackModelsRead): void => {
  const source = userConfigPath(getAgentDir());

  for (const problem of read.problems) {
    notifyOnce(ui, source, problem, problem, 'error');
  }

  for (const warning of read.warnings) {
    notifyOnce(ui, source, warning, warning, 'warning');
  }
};
