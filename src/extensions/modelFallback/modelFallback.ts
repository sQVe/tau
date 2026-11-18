import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readFallbackModels } from '../../config/fallbackModels.js';
import { registerFallbackModels } from './fallbackRegistration.js';
import { reportFallbackModels } from './fallbackReport.js';

export default function modelFallbackExtension(pi: ExtensionAPI): void {
  const registered = readFallbackModels({
    cwd: process.cwd(),
    agentDirectory: getAgentDir(),
    projectTrusted: false,
  });

  registerFallbackModels(pi, registered.models);

  pi.on('session_start', (_event, context) => {
    const read = readFallbackModels({
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });

    reportFallbackModels(context.ui, read);
  });
}
