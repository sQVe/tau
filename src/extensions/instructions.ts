import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { defaultInstructionSetNames, readInstructionSet } from '../instructions/instructions.js';
import { appendSystemPrompt } from '../instructions/systemPrompt.js';
import { isWorkerProcess } from '../worker.js';

export default async function instructionsExtension(pi: ExtensionAPI): Promise<void> {
  const instructionSets = await Promise.all(defaultInstructionSetNames.map(readInstructionSet));

  // A worker appends the instruction sets its saved task lists.
  if (isWorkerProcess()) {
    return;
  }

  for (const instructions of instructionSets) {
    pi.on('before_agent_start', (event) => {
      appendSystemPrompt(event, instructions);
    });
  }
}
