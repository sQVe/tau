import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readInstructionSet } from '../instructionSets.js';
import { appendSystemPrompt } from '../systemPrompt.js';
import { isWorkerProcess } from '../workerProcess.js';

export default async function codingExtension(pi: ExtensionAPI): Promise<void> {
  const instructions = await readInstructionSet('coding');

  // A worker appends the instruction sets its saved task lists.
  if (isWorkerProcess()) {
    return;
  }

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, instructions);
  });
}
