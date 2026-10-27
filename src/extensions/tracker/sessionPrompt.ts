import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { readOriginRepository } from '../../github/repositoryTarget.js';
import { configRepositoryKey } from '../../github/repositoryTargetDecisions.js';
import { readTrackerSetup } from './config.js';
import { trackerLines } from './promptLines.js';

export const readSessionPromptLines = async (
  pi: ExtensionAPI,
  context: ExtensionContext,
): Promise<string[]> => {
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
