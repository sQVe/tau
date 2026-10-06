import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isNestedChangeCall, nestedChangeCallReason } from '../controlTools.js';
import { readInstructionSet } from '../instructionSets.js';
import { appendSystemPrompt, appendToolGuidelines } from '../systemPrompt.js';
import { isWorkerProcess } from '../workerProcess.js';

export const codemodeGuidelines = [
  "Call `read` and `bash` directly for a single lookup. Use codemode only when one script batches several calls or filters output before it returns. Follow a skill's script step when the skill asks for one.",
  'Gather evidence only. Never call `write`, `edit`, `commit`, `run_tests`, or report, question, progress, or orchestration tools from a script.',
  '`searchTools()`, `describeTool()`, and `describeNamespace()` return promises. Always `await` them: `const found = await searchTools("linear");`.',
  'Print strings, not result objects: `text(result.output)`. Add `exit_code`, `truncated`, and `full_output_path` only when they are not the default.',
  'Filter before printing. Return line-numbered excerpts with their file. Start scripts with `// @options: {"max_output_tokens": 4000}` and raise it only when needed. Name what the script dropped as a gap.',
  'Cite only what a script or a direct tool call returned.',
];

export default async function workflowExtension(pi: ExtensionAPI): Promise<void> {
  const instructions = await readInstructionSet('workflow');

  appendToolGuidelines(pi, 'codemode', codemodeGuidelines);

  // A worker appends the instruction sets its saved task lists, and the worker extension refuses
  // nested change calls, because a launched worker may run without Tau.
  if (isWorkerProcess()) {
    return;
  }

  pi.on('tool_call', (event) => {
    if (!isNestedChangeCall(event)) {
      return undefined;
    }

    return { block: true, reason: nestedChangeCallReason };
  });

  pi.on('before_agent_start', (event) => {
    appendSystemPrompt(event, instructions);
  });
}
