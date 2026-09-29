import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readInstructionSet } from '../../instructionSets/index.js';
import { appendSystemPrompt } from '../../systemPrompt/index.js';
import { isWorkerProcess } from '../../workerProcess/index.js';

export default async function codingExtension(pi: ExtensionAPI) {
  const instructions = await readInstructionSet('coding');

  // A worker appends the instruction sets its saved task lists.
  if (isWorkerProcess()) {
    return;
  }

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, instructions);
  });
}
