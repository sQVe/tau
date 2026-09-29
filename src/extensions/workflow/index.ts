import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readInstructionSet } from '../../instructionSets/index.js';
import { appendSystemPrompt } from '../../systemPrompt/index.js';
import { isWorkerProcess } from '../../workerProcess/index.js';

export default async function workflowExtension(pi: ExtensionAPI) {
  const instructions = await readInstructionSet('workflow');

  // A worker appends the instruction sets its saved task lists.
  if (isWorkerProcess()) {
    return;
  }

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, instructions);
  });
}
