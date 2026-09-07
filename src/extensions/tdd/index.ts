import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

import { guardToolCall } from './guard.js';
import { createEvidenceStore } from './state.js';

export default function tddExtension(pi: ExtensionAPI) {
  const store = createEvidenceStore();
  pi.on('tool_call', (event, ctx) => guardToolCall(event, ctx.cwd, store));
  pi.registerTool(
    defineTool({
      name: 'run_tests',
      label: 'Run tests',
      description: 'Run tests for a named behavior and record TDD evidence.',
      parameters: Type.Object({
        behavior: Type.String({ minLength: 1 }),
        testFullName: Type.String({ minLength: 1 }),
        files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        scope: Type.Union([Type.Literal('focused'), Type.Literal('full')]),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        const { scope, ...behavior } = params;
        const details = await store.run(ctx.cwd, behavior, scope);
        const output = JSON.stringify({
          kind: details.kind,
          implementationAllowed: details.implementationAllowed,
          report: details.kind === 'inputs-changed' ? null : details.evidence.latestRun?.report,
        });
        const text = output.length > 4000 ? `${output.slice(0, 3980)}\n[truncated]` : output;
        return { content: [{ type: 'text', text }], details };
      },
    }),
  );
}
