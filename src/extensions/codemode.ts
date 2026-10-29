import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerCodemodeBudget } from '../codemode/codemode.js';
import { isNestedChangeCall, nestedChangeCallReason } from '../codemode/controlTools.js';
import { codemodeGuidelines } from '../codemode/guidelines.js';
import { appendToolGuidelines } from '../instructions/systemPrompt.js';
import { isWorkerProcess } from '../worker.js';

export default function codemodeExtension(pi: ExtensionAPI): void {
  const guidelines = isWorkerProcess() ? [] : codemodeGuidelines;

  appendToolGuidelines(pi, 'codemode', guidelines);

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
