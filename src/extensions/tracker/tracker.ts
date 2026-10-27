import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { forgetReportedWarnings } from '../../config/config.js';
import { readOriginRepository } from '../../github/repositoryTarget.js';
import { configRepositoryKey } from '../../github/repositoryTargetDecisions.js';
import { appendSystemPrompt } from '../../instructions/systemPrompt.js';
import { isWorkerProcess } from '../../worker.js';
import { readTrackerSetup } from './config.js';
import { createTrackerDraftTool } from './draftTool.js';
import { trackerLines } from './promptLines.js';
import { createTrackerEvidenceTool } from './tool.js';

const readPromptLines = async (pi: ExtensionAPI, context: ExtensionContext): Promise<string[]> => {
  const location = {
    cwd: context.cwd,
    agentDirectory: getAgentDir(),
    projectTrusted: context.isProjectTrusted(),
  };

  const origin = await readOriginRepository({
    exec: (command, commandArguments, options) => pi.exec(command, commandArguments, options),
    cwd: location.cwd,
  });

  const repository = origin.status === 'named' ? configRepositoryKey(origin.repository) : undefined;
  const setup = readTrackerSetup(location, context.ui, repository);

  return trackerLines({ setup, origin });
};

export default function trackerExtension(pi: ExtensionAPI): void {
  pi.registerTool(createTrackerDraftTool());

  pi.registerTool(
    createTrackerEvidenceTool((command, commandArguments, options) =>
      pi.exec(command, commandArguments, options),
    ),
  );

  if (isWorkerProcess()) {
    return;
  }

  let promptLines: string[] = [];

  pi.on('session_start', async (_event, context) => {
    forgetReportedWarnings(context.ui);
    promptLines = await readPromptLines(pi, context);
  });

  pi.on('before_agent_start', (event) => {
    if (promptLines.length > 0) {
      appendSystemPrompt(event, promptLines.map((line) => `- ${line}`).join('\n'));
    }
  });
}
