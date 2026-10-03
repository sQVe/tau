import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { requireRegisteredTools } from '../bundledTools.js';
import { resolveAllowedModel } from '../models/models.js';

const requiredWebAccessTools = ['web_search', 'fetch_content'];

export default function webAccessExtension(pi: ExtensionAPI): void {
  requireRegisteredTools(pi, 'pi-web-access', requiredWebAccessTools);

  // pi-web-access treats a blank answerModel as absent and uses its own fetch.answerModel setting,
  // then the session model. Tau checks only a model the caller passes.
  pi.on('tool_call', (event, context) => {
    if (event.toolName !== 'fetch_content' || event.input.mode !== 'answer') {
      return;
    }

    const passed = event.input.answerModel;

    if (typeof passed !== 'string' || passed.trim() === '') {
      return;
    }

    const reference = passed.trim();
    const model = resolveAllowedModel(context, reference);
    // pi-web-access prefers an available router over a native model missing from its availability
    // snapshot. Block that route, but let native models resolve credentials at execution time.
    const available = context.modelRegistry.getAvailable();

    const nativeAvailable = available.some(
      (candidate) => candidate.provider === model.provider && candidate.id === model.id,
    );

    const routedAvailable = available.some((candidate) => candidate.id === reference);

    if (!nativeAvailable && routedAvailable) {
      throw new Error(
        `Answer model ${reference} is not available. Check its authentication and pi --list-models.`,
      );
    }

    event.input.answerModel = reference;
  });
}
