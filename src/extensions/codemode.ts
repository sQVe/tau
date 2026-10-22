import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerCodemodeBudget } from '../codemode/codemode.js';
import { isNestedChangeCall, nestedChangeCallReason } from '../codemode/controlTools.js';
import { appendToolGuidelines } from '../systemPrompt.js';
import { isWorkerProcess } from '../workerProcess.js';

export const codemodeGuidelines = [
  "Call `read` and `bash` directly for a single lookup. Use codemode only when one script batches several calls or filters output before it returns. Follow a skill's script step when the skill asks for one.",
  'Gather evidence only. Never call `write`, `edit`, `commit`, `run_tests`, or report, question, progress, or orchestration tools from a script.',
  'To write several files, make one `write` call per file in the same turn.',
  '`searchTools()`, `describeTool()`, and `describeNamespace()` return promises. Always `await` them: `const found = await searchTools("linear");`.',
  'Print strings, not result objects: `text(result.output)`. Add `exit_code`, `truncated`, and `full_output_path` only when they are not the default.',
  'Filter before printing. Return line-numbered excerpts with their file. Name what the script dropped as a gap.',
  'A script has an output budget of 4,000 tokens. To raise it, set `max_output_tokens` on the first line and add the reason on a second line: `// @budget: <reason>`. Tau refuses a raise without a reason. Over the budget, Tau cuts whole `text()` items and names each cut item.',
  'Discover paths first, then batch independent reads in one script. Use `Promise.allSettled` and print each failed path as a gap. Read bounded ranges with `offset` and `limit`. Read a document that must be whole in its own call.',
  'Never `JSON.parse` the text of `read`, which may be capped. Query data files with a bounded command such as `jq`.',
  'Launch independent workers in one turn.',
  'Cite only what a script or a direct tool call returned.',
];

export default function codemodeExtension(pi: ExtensionAPI): void {
  appendToolGuidelines(pi, 'codemode', codemodeGuidelines);

  // The worker extension refuses nested change calls in a worker, because a launched worker may run
  // without Tau.
  if (isWorkerProcess()) {
    return;
  }

  const checkCodemodeBudget = registerCodemodeBudget(pi);

  pi.on('tool_call', (event) => {
    const refusal = checkCodemodeBudget(event);

    if (refusal !== undefined) {
      return refusal;
    }

    if (!isNestedChangeCall(event)) {
      return undefined;
    }

    return { block: true, reason: nestedChangeCallReason };
  });
}
