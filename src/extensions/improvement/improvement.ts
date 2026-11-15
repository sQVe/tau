import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { isWorkerProcess } from '../../worker.js';
import { runRecord } from './recordAction.js';

const parameters = Type.Object({
  action: Type.Literal('record'),
  summary: Type.Optional(Type.String({ description: 'record: one sentence.' })),
});

const description = '- record: save a user correction. {id,path,outcome}; existing: saved before.';

export default function improvementExtension(pi: ExtensionAPI): void {
  if (isWorkerProcess()) {
    return;
  }

  pi.registerTool(
    defineTool({
      name: 'improvement',
      label: 'Improvement',
      description,
      promptSnippet: 'Record a user correction.',
      parameters,
      async execute(toolCallId, input, _signal, _onUpdate, context) {
        const details = await runRecord(toolCallId, input.summary, context);

        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      },
    }),
  );
}
