import { relative, resolve } from 'node:path';

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolResultEvent,
} from '@earendil-works/pi-coding-agent';
import { defineTool, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { Type } from 'typebox';

import { forgetReportedWarnings } from '../../tauConfig.js';
import { classifyPath, loadTddConfig } from './config.js';
import type { LoadedTddConfig } from './config.js';
import { createTestObservation, observationDirectory } from './observation.js';
import { configSummary, runContext, selectionSummary, summarize } from './render.js';
import type { TestObservation } from './types.js';

interface ObservationTracker {
  current:
    | { cwd: string; key: string; loaded: LoadedTddConfig; observation: TestObservation }
    | undefined;
  reportedConfigError: string | undefined;
}

const runTestsDescription = [
  'Runs Vitest only; use the project runner for other test frameworks.',
  'Run a failing focused test (RED), implement, rerun the same selection (GREEN), then verify the full suite once with scope "full" or the repository full check.',
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

const observationFor = async (tracker: ObservationTracker, context: ExtensionContext) => {
  const cwd = await observationDirectory(context.cwd);

  const location = {
    cwd,
    agentDirectory: getAgentDir(),
    projectTrusted: context.isProjectTrusted(),
  };

  const loaded = loadTddConfig(location, context.ui);

  const key = JSON.stringify(loaded);

  if (tracker.current?.cwd !== cwd || tracker.current.key !== key) {
    tracker.current = { cwd, key, loaded, observation: createTestObservation(cwd, loaded.config) };
  }

  return tracker.current;
};

const withNotice = (
  event: ToolResultEvent,
  context: ExtensionContext,
  text: string,
  level: 'info' | 'warning' = 'info',
) => {
  if (context.hasUI) {
    context.ui.notify(text, level);
  }

  return {
    content: [...event.content, { type: 'text' as const, text }],
    ...(event.structuredContent === undefined
      ? {}
      : { structuredContent: event.structuredContent }),
  };
};

const handleToolResult = async (
  tracker: ObservationTracker,
  event: ToolResultEvent,
  context: ExtensionContext,
) => {
  if (!['write', 'edit', 'bash'].includes(event.toolName)) {
    return undefined;
  }

  let current: Awaited<ReturnType<typeof observationFor>>;

  try {
    current = await observationFor(tracker, context);
  } catch (error) {
    const message = `TDD hints are paused: ${error instanceof Error ? error.message : String(error)}`;

    if (tracker.reportedConfigError === message) {
      return undefined;
    }

    tracker.reportedConfigError = message;

    return withNotice(event, context, message, 'warning');
  }

  tracker.reportedConfigError = undefined;
  const { cwd, loaded, observation } = current;
  const path = typeof event.input.path === 'string' ? event.input.path.replace(/^@/, '') : '';
  const target = await observationDirectory(resolve(context.cwd, path));
  const editablePath = event.toolName !== 'bash' && path.length > 0;

  const productionEdit =
    !event.isError &&
    editablePath &&
    classifyPath(loaded.config, relative(cwd, target)) === 'production';

  const hint = await observation.checkpoint(productionEdit);

  return hint === undefined ? undefined : withNotice(event, context, hint);
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
      async execute(_toolCallId, parameters, signal, onUpdate, context) {
        const { scope, ...behavior } = parameters;

        onUpdate?.({
          content: [
            { type: 'text', text: `Preparing test run\n${selectionSummary(behavior, scope)}` },
          ],
          details: undefined,
        });

        const { cwd, loaded, observation } = await observationFor(tracker, context);

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

export default function tddExtension(pi: ExtensionAPI): void {
  const tracker: ObservationTracker = { current: undefined, reportedConfigError: undefined };

  pi.on('session_start', (_event, context) => {
    forgetReportedWarnings(context.ui);
    tracker.current = undefined;
    tracker.reportedConfigError = undefined;
  });

  pi.on('session_shutdown', () => {
    tracker.current = undefined;
  });

  pi.on('tool_result', (event, context) => handleToolResult(tracker, event, context));

  registerRunTestsTool(pi, tracker);
}
