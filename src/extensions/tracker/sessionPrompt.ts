import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { readRepositorySetup } from './config.js';
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

  const facts = await readRepositorySetup(
    (command, commandArguments, options) => pi.exec(command, commandArguments, options),
    location,
    context.ui,
  );

  return trackerLines(facts);
};
