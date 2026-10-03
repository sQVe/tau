import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readInstructionSet } from '../instructionSets.js';
import { appendSystemPrompt } from '../systemPrompt.js';
import { isWorkerProcess } from '../workerProcess.js';

export default async function workflowExtension(pi: ExtensionAPI): Promise<void> {
  const instructions = await readInstructionSet('workflow');

  // A worker appends the instruction sets its saved task lists.
  if (isWorkerProcess()) {
    return;
  }

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, instructions);
  });
}
