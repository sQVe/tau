import { isAbsolute, relative, resolve } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { classifyPath } from './config.js';
import { createTestObservation, observationDirectory } from './observation.js';
import type { RunnerResult } from './runner/types.js';
import { maximumFailures } from './runner/types.js';

const maximumSummaryCharacters = 2000;

const summarize = (cwd: string, report: RunnerResult, freshness: string): string => {
  const lines = [`${report.kind} · ${freshness}`];

  if ('message' in report) {
    lines.push(report.message);
  }

  if ('tests' in report) {
    const count = (...statuses: string[]) =>
      report.tests.filter((test) => statuses.includes(test.status)).length;

    lines.push(
      `${count('passed')} passed, ${count('failed')} failed, ${count('skipped', 'todo')} skipped`,
    );
  }

  const failures = 'failures' in report ? report.failures : [];
  let shown = 0;

  for (const failure of failures.slice(0, maximumFailures)) {
    const file = isAbsolute(failure.file) ? relative(cwd, failure.file) : failure.file;
    const entry = `✗ ${file} › ${failure.fullname}\n    ${failure.message}`;

    if ([...lines, entry].join('\n').length > maximumSummaryCharacters - 60) {
      break;
    }

    lines.push(entry);
    shown += 1;
  }

  if (failures.length > shown) {
    lines.push(`+${failures.length - shown} more`);
  }

  if ('truncated' in report && report.truncated) {
    lines.push('further failures were not collected');
  }

  const text = lines.join('\n');

  return text.length > maximumSummaryCharacters
    ? `${text.slice(0, maximumSummaryCharacters - 12)}\n[cut]`
    : text;
};

export default function tddExtension(pi: ExtensionAPI) {
  let current: { cwd: string; observation: ReturnType<typeof createTestObservation> } | undefined;

  const observationFor = async (directory: string) => {
    const cwd = await observationDirectory(directory);

    if (current?.cwd !== cwd) {
      current = { cwd, observation: createTestObservation(cwd) };
    }

    return current;
  };

  pi.on('session_start', () => {
    current = undefined;
  });

  pi.on('session_shutdown', () => {
    current = undefined;
  });

  pi.on('tool_result', async (event, context) => {
    if (!['write', 'edit', 'bash'].includes(event.toolName)) {
      return undefined;
    }

    const { cwd, observation } = await observationFor(context.cwd);
    const path = typeof event.input.path === 'string' ? event.input.path.replace(/^@/, '') : '';
    const target = await observationDirectory(resolve(context.cwd, path));
    const productionEdit =
      !event.isError &&
      event.toolName !== 'bash' &&
      path.length > 0 &&
      classifyPath(relative(cwd, target)) === 'production';
    const hint = await observation.checkpoint(productionEdit);

    if (hint === undefined) {
      return undefined;
    }

    return { content: [...event.content, { type: 'text' as const, text: hint }] };
  });

  pi.registerTool(
    defineTool({
      name: 'run_tests',
      label: 'Run tests',
      description:
        'Run focused tests for a behavior, then the full suite. Use exact Vitest full names: join describe names and the it name with spaces, for example "outer inner works". ' +
        'Start with a failing focused test (RED), implement the behavior, then rerun focused (GREEN) and scope "full". These are observations, never edit permissions. ' +
        'Returns kind, scope, freshness (fresh, stale, or unknown), and the actual runner report, even when inputs changed during the run. ' +
        'A full pass counts without prior RED or focused renewal after formatting. Duplicate, skipped, and missing tests cannot establish RED. ' +
        'Short session-local hints suggest missing RED, full verification, or rerunning stale results. Hints never block or require acknowledgment. ' +
        'Freshness covers source, test, and configuration content at bounded checkpoints, not an atomic snapshot. The summary is capped at 2000 characters, plus at most one hint; details keep the runner report.',
      parameters: Type.Object({
        behavior: Type.String({
          minLength: 1,
          description: 'Name the behavior. This label does not affect test selection.',
        }),
        testFullName: Type.Union(
          [
            Type.String({ minLength: 1 }),
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          ],
          {
            description:
              'Exact Vitest full name, or names that prove one behavior together. Keep names stable between focused runs.',
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
      }),
      async execute(_toolCallId, parameters, signal, _onUpdate, context) {
        const { cwd, observation } = await observationFor(context.cwd);
        const { scope, ...behavior } = parameters;
        const { hint, ...details } = await observation.run(behavior, scope, signal);
        const content = [
          { type: 'text' as const, text: summarize(cwd, details.report, details.freshness) },
        ];

        if (hint !== undefined) {
          content.push({ type: 'text', text: hint });
        }

        return { content, details };
      },
    }),
  );
}
