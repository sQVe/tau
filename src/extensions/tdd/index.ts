import { relative, resolve } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { classifyPath } from './config.js';
import { createTestObservation, observationDirectory } from './observation.js';
import { runContext, selectionSummary, summarize } from './render.js';
import type { TestObservation } from './types.js';

interface ObservationTracker {
  current: { cwd: string; observation: TestObservation } | undefined;
}

const runTestsDescription =
  'Run focused tests for a behavior, then the full suite. Use exact names for the installed Vitest version: join describe names and the it name with spaces in Vitest 4 ("outer inner works") or " > " in Vitest 5 ("outer > inner > works"). ' +
  'Names are literal, not regexes. On no match, use the reported collected names; do not restructure tests or broaden selection. ' +
  'Start with a failing focused test (RED), implement the behavior, then rerun focused (GREEN) and verify the full suite through the repository full check or scope "full". These are observations, never edit permissions. ' +
  'Returns kind, scope, freshness (fresh, stale, or unknown), and the actual runner report, even when inputs changed during the run. ' +
  'A full pass counts without prior RED or focused renewal after formatting. A repository full check that already ran the suite on the current inputs satisfies full verification; do not run a second full suite only for bookkeeping. Duplicate, skipped, and missing tests cannot establish RED. ' +
  'Short session-local hints suggest missing RED, RED from a thrown error instead of a failed assertion, full verification, or rerunning stale results. Hints never block or require acknowledgment. ' +
  'Freshness covers .ts/.tsx/.js/.jsx/.mjs/.cjs under root src/, apps/, packages/, functions/, and infra/, plus test/spec files and root tests/ helpers. ' +
  'It also covers default-named package/Vite/Vitest/TypeScript configs, npm/pnpm/Yarn/Bun lockfiles, and pnpm/Vitest workspace files throughout the worktree. ' +
  'Dependencies and common generated/cache directories are excluded. Other source layouts, assets, and custom config filenames are not covered. ' +
  'Checks run at bounded checkpoints, not an atomic snapshot or reusable verification. ' +
  'Shows focused files and exact names, or full-suite scope. Focused summaries show each selected test duration; full summaries list only tests over 1000 ms outside .integration. files. The summary is capped at 2000 characters, with up to 4000 characters of run context and at most one hint. ' +
  'Read the saved run.json for command, selection, and before/after input fingerprints. Diagnostics retain up to 8 MiB stdout, 32 KiB stderr, and 8 MiB raw JSON, including passes. ' +
  'Console output beyond the capture limit is discarded without stopping tests. Truncation distinguishes process bytes from decoded text bytes. ' +
  'Files live in the Pi agent test-runs directory. After each run, cleanup keeps up to 32 completed runs for seven days; recent unfinished runs are protected. ' +
  'Runner output is diagnostic text, never the source of test verdicts. ' +
  'Resolution failures include safe error codes/types and available lookup paths. Inspect once, then fix resolution or use the repository runner. ' +
  'Bash tests do not update Tau observations.';

const runTestsParameters = Type.Object({
  behavior: Type.String({
    minLength: 1,
    description: 'Name the behavior. This label does not affect test selection.',
  }),
  testFullName: Type.Union(
    [Type.String({ minLength: 1 }), Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })],
    {
      description:
        'Exact Vitest test name: nested names use spaces in Vitest 4 and " > " in Vitest 5. An array selects names that prove one behavior together. Keep names stable between focused runs.',
    },
  ),
  files: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    description:
      'Literal worktree-relative test file paths. Keep files stable between focused runs.',
  }),
  scope: Type.Union([Type.Literal('focused'), Type.Literal('full')], {
    description:
      'focused selects the exact names in the supplied files; full runs the whole suite.',
  }),
});

const observationFor = async (tracker: ObservationTracker, directory: string) => {
  const cwd = await observationDirectory(directory);

  if (tracker.current?.cwd !== cwd) {
    tracker.current = { cwd, observation: createTestObservation(cwd) };
  }

  return tracker.current;
};

const handleToolResult = async (
  tracker: ObservationTracker,
  event: ToolResultEvent,
  context: ExtensionContext,
) => {
  if (!['write', 'edit', 'bash'].includes(event.toolName)) {
    return undefined;
  }

  const { cwd, observation } = await observationFor(tracker, context.cwd);
  const path = typeof event.input.path === 'string' ? event.input.path.replace(/^@/, '') : '';
  const target = await observationDirectory(resolve(context.cwd, path));
  const editablePath = event.toolName !== 'bash' && path.length > 0;

  const productionEdit =
    !event.isError && editablePath && classifyPath(relative(cwd, target)) === 'production';

  const hint = await observation.checkpoint(productionEdit);

  if (hint === undefined) {
    return undefined;
  }

  if (context.hasUI) {
    context.ui.notify(hint, 'info');
  }

  return { content: [...event.content, { type: 'text' as const, text: hint }] };
};

const registerRunTestsTool = (pi: ExtensionAPI, tracker: ObservationTracker): void => {
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
      // eslint-disable-next-line eslint/max-params -- Pi calls execute with five positional arguments.
      async execute(_toolCallId, parameters, signal, onUpdate, context) {
        const { scope, ...behavior } = parameters;

        onUpdate?.({
          content: [
            { type: 'text', text: `Preparing test run\n${selectionSummary(behavior, scope)}` },
          ],
          details: undefined,
        });

        const { cwd, observation } = await observationFor(tracker, context.cwd);

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
        ];

        if (hint !== undefined) {
          content.unshift({ type: 'text', text: hint });
        }

        return { content, details };
      },
    }),
  );
};

export default function tddExtension(pi: ExtensionAPI) {
  const tracker: ObservationTracker = { current: undefined };

  pi.on('session_start', () => {
    tracker.current = undefined;
  });

  pi.on('session_shutdown', () => {
    tracker.current = undefined;
  });

  pi.on('tool_result', (event, context) => handleToolResult(tracker, event, context));

  registerRunTestsTool(pi, tracker);
}
