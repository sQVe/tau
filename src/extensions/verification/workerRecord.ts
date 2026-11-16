import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';

import { recordItem } from './itemWrite.js';
import { recordParameters } from './recordParameters.js';

const description =
  'Save one hand-driven result for an item registered in a verification run: one result per registered step, in order, and the endState. Artifact paths are relative to the run directory and must exist there. Each item is saved once; a refusal saves nothing.';

export default function workerRecordExtension(pi: ExtensionAPI): void {
  pi.registerTool(
    defineTool({
      name: 'verification_record',
      label: 'Verification record',
      description,
      promptSnippet: 'Save one hand-driven verification result.',
      parameters: recordParameters,
      async execute(_toolCallId, input, _signal, _onUpdate, context) {
        const saved = await recordItem(context.cwd, input);
        const details = { status: 'saved' as const, ...saved };

        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      },
    }),
  );
}
