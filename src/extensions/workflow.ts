import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { readInstructionSet } from '../instructionSets.js';
import { appendSystemPrompt, appendToolGuidelines } from '../systemPrompt.js';
import { isWorkerProcess } from '../workerProcess.js';

export const codemodeGuidelines = [
  'Use codemode to gather evidence. Plan one script per evidence set.',
  'Keep raw output out of context. Return bounded, line-numbered excerpts with command status and the gaps the script found.',
  'Cite only what a script returned. If a script filtered out a fact, gather and return it before you cite it.',
  'Never call report, question, progress, or orchestration tools from a script.',
];

export default async function workflowExtension(pi: ExtensionAPI): Promise<void> {
  const instructions = await readInstructionSet('workflow');

  appendToolGuidelines(pi, 'codemode', codemodeGuidelines);

  // A worker appends the instruction sets its saved task lists.
  if (isWorkerProcess()) {
    return;
  }

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, instructions);
  });
}
