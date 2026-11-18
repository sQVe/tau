import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { trackGuideRuns } from '../instructions/guideRuns.js';
import {
  defaultInstructionSetNames,
  instructionTexts,
  readInstructionSections,
} from '../instructions/instructions.js';
import { appendSystemPrompt } from '../instructions/systemPrompt.js';
import { registerTypeScriptRules } from '../instructions/typescriptRules.js';
import { isWorkerProcess } from '../role/role.js';

export default async function instructionsExtension(pi: ExtensionAPI): Promise<void> {
  const sections = await readInstructionSections(defaultInstructionSetNames);

  // A worker appends the instruction sets its saved task lists.
  if (isWorkerProcess()) {
    return;
  }

  registerTypeScriptRules(pi);

  const guideRuns = trackGuideRuns(pi);

  pi.on('before_agent_start', async (event) => {
    for (const text of await instructionTexts(sections, guideRuns)) {
      appendSystemPrompt(event, text);
    }
  });
}
