import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readFallbackModels } from './fallbackConfig.js';
import { registerFallbackModels } from './fallbackRegistration.js';
import { reportFallbackModels, writeFallbackModelsReport } from './fallbackReport.js';
import { shouldReportAtStartup } from './startupReport.js';

export default function modelFallbackExtension(pi: ExtensionAPI): void {
  const registered = readFallbackModels({
    cwd: process.cwd(),
    agentDirectory: getAgentDir(),
    projectTrusted: false,
  });

  registerFallbackModels(pi, registered.models);

  if (
    shouldReportAtStartup({
      argv: process.argv.slice(2),
      stdinIsTerminal: process.stdin.isTTY,
      stdoutIsTerminal: process.stdout.isTTY,
    })
  ) {
    writeFallbackModelsReport((text) => {
      process.stderr.write(text);
    }, registered);
  }

  pi.on('session_start', (_event, context) => {
    const read = readFallbackModels({
      cwd: context.cwd,
      agentDirectory: getAgentDir(),
      projectTrusted: context.isProjectTrusted(),
    });

    reportFallbackModels(context.ui, read);
  });
}
