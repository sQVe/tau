import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { trackGuideRuns } from '../instructions/guideRuns.js';
import {
  bundledInstructionsDirectory,
  defaultInstructionSetNames,
  instructionTexts,
  readInstructionSections,
} from '../instructions/instructions.js';
import { registerLanguageRules } from '../instructions/languageRules/languageRules.js';
import { appendSystemPrompt } from '../instructions/systemPrompt.js';
import { isWorkerProcess } from '../role/role.js';

export const registerInstructions = async (pi: ExtensionAPI, directory: string): Promise<void> => {
  const sections = await readInstructionSections(defaultInstructionSetNames, directory);

  // A worker appends the instruction sets its saved task lists.
  if (isWorkerProcess()) {
    return;
  }

  const guideRuns = trackGuideRuns(pi);

  registerLanguageRules(pi, guideRuns);

  pi.on('before_agent_start', async (event) => {
    for (const text of await instructionTexts(sections, guideRuns)) {
      appendSystemPrompt(event, text);
    }
  });
};

export default async function instructionsExtension(pi: ExtensionAPI): Promise<void> {
  await registerInstructions(pi, bundledInstructionsDirectory);
}
