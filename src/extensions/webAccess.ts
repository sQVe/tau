import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { resolveAllowedModel } from '../models/models.js';
import { isWorkerProcess } from '../workerProcess.js';

const requiredWebAccessTools = ['web_search', 'fetch_content'];

const requireWebAccessTools = (pi: ExtensionAPI): void => {
  // A worker registers only its profile's tools and checks those itself.
  if (isWorkerProcess()) {
    return;
  }

  pi.on('session_start', () => {
    const registeredToolNames = new Set(pi.getAllTools().map((tool) => tool.name));

    const missingToolNames = requiredWebAccessTools.filter(
      (name) => !registeredToolNames.has(name),
    );

    if (missingToolNames.length === 0) {
      return;
    }

    const quotedToolNames = missingToolNames.map((name) => `"${name}"`).join(', ');

    const subject =
      missingToolNames.length === 1 ? `Tool ${quotedToolNames} is` : `Tools ${quotedToolNames} are`;

    throw new Error(
      `${subject} not registered. The bundled package pi-web-access either failed to load or has configuration that disables or renames tools. Reinstall Tau if the package failed to load.`,
    );
  });
};

export default function webAccessExtension(pi: ExtensionAPI): void {
  requireWebAccessTools(pi);

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
