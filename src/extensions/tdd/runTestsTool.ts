import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import type { ObservationTracker } from './observationTracker.js';
import { configSummary, runContext, selectionSummary, summarize } from './render.js';
import { runners } from './runner/runners.js';

const nameFormats = Object.values(runners)
  .map((runner) => `${runner.name}: ${runner.testNameFormat}.`)
  .join(' ');

const runTestsDescription = [
  'Runs the configured runner; use bash for other frameworks.',
  'Run a failing focused test (RED), implement, and rerun the same selection (GREEN). The PR step runs the full suite.',
  'RED/GREEN are observations, never edit permissions. Duplicate, skipped, and missing tests cannot establish RED.',
  'Returns report, freshness (fresh, stale, unknown), and at most one hint. Bash runs add no observations.',
].join(' ');

const testFullNameDescription = `Exact literal test name. ${nameFormats} Arrays select names proving one behavior.`;

const runTestsParameters = Type.Object({
  behavior: Type.String({
    minLength: 1,
    description: 'Label only; it does not select tests.',
  }),
  testFullName: Type.Union(
    [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
    {
      description: testFullNameDescription,
    },
  ),
  files: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description: 'Worktree-relative tests; affected also accepts sources and ignores names.',
  }),
  scope: Type.Union([Type.Literal('focused'), Type.Literal('affected'), Type.Literal('full')], {
    description:
      'focused: named tests; affected: tests related to files, ignoring names; full: whole suite.',
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
