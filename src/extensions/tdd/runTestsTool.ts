import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import type { ObservationTracker } from './observationTracker.js';
import { configSummary, runContext, selectionSummary, summarize } from './render.js';

const runTestsDescription = [
  'Runs Vitest only; use the project runner for other test frameworks.',
  'Run a failing focused test (RED), implement, and rerun the same selection (GREEN). The PR step runs the full suite.',
  'RED and GREEN are observations, never edit permissions. Duplicate, skipped, and missing tests cannot establish RED.',
  'Returns the runner report, input freshness (fresh, stale, or unknown), and at most one hint. Bash test runs do not update these observations.',
].join(' ');

const runTestsParameters = Type.Object({
  behavior: Type.String({
    minLength: 1,
    description: 'Label only; it does not select tests.',
  }),
  testFullName: Type.Union(
    [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
    {
      description:
        'Exact literal test name. Vitest 4 joins nested names with spaces, Vitest 5 with " > ". An array selects names that prove one behavior.',
    },
  ),
  files: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: 'Worktree-relative test file paths.',
  }),
  scope: Type.Union([Type.Literal('focused'), Type.Literal('full')], {
    description: 'focused runs the named tests in files; full runs the whole suite.',
  }),
});

export const registerRunTestsTool = (pi: ExtensionAPI, tracker: ObservationTracker): void => {
  pi.registerTool(
    defineTool({
      name: 'run_tests',
      label: 'Run tests',
      description: runTestsDescription,
      parameters: runTestsParameters,
      renderCall(parameters, theme) {
        return new Text(
          `${theme.fg('toolTitle', theme.bold('Run tests'))}\n${selectionSummary(parameters, parameters.scope)}`,
          0,
          0,
        );
      },
      async execute(_toolCallId, parameters, signal, onUpdate, context) {
        const { scope, ...behavior } = parameters;

        onUpdate?.({
          content: [
            { type: 'text', text: `Preparing test run\n${selectionSummary(behavior, scope)}` },
          ],
          details: undefined,
        });

        const { cwd, loaded, observation } = await tracker.observationFor(context);

        const { hint, ...details } = await observation.run(behavior, scope, signal, (selected) => {
          onUpdate?.({
            content: [
              { type: 'text', text: `Running tests\n${selectionSummary(selected, scope)}` },
            ],
            details: undefined,
          });
        });

        const content = [
          { type: 'text' as const, text: summarize(cwd, details) },
          { type: 'text' as const, text: runContext(behavior, details) },
          { type: 'text' as const, text: configSummary(loaded) },
        ];

        if (hint !== undefined) {
          content.unshift({ type: 'text', text: hint });
        }

        return { content, details };
      },
    }),
  );
};
