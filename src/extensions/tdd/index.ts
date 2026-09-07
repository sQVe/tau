import { resolve } from 'node:path';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

import { guardToolCall } from './guard.js';
import { createEvidenceStore, hasAmbiguousIdentity } from './state.js';

export default function tddExtension(pi: ExtensionAPI) {
  const store = createEvidenceStore();
  pi.on('tool_call', (event, ctx) => guardToolCall(event, ctx.cwd, store));
  pi.registerTool(
    defineTool({
      name: 'run_tests',
      label: 'Run tests',
      description:
        'Name a behavior, its test files, and the exact Vitest full name: describe names followed by the it name, joined with spaces, for example "outer inner works". ' +
        'Run scope "focused" to prove RED before editing production files, run focused again for GREEN after the fix, then run scope "full" at the end for verified. ' +
        'Editing a required test file after RED re-locks the gate; if edited after the fix, save and revert only the production change with git restore/stash, re-run focused to prove RED, then restore the fix. ' +
        'Skipped and deleted tests never count. ' +
        'Returns kind (run outcome), phase (locked: no valid RED; red: failing test proven; green: that test passed; verified: full run passed with every RED test present and passing), implementationAllowed (true only in red), and report (test results, null if inputs changed). ' +
        'A next string explains recovery when needed; long reports are truncated in text, with the full report in details.',
      parameters: Type.Object({
        behavior: Type.String({
          minLength: 1,
          description:
            'Name the behavior to implement; keep it unchanged through RED, GREEN, and full verification.',
        }),
        testFullName: Type.String({
          minLength: 1,
          description:
            'Exact Vitest full name: describe names then the it name, joined with spaces, not " > "; for example "outer inner works". Use the same name for focused and full runs.',
        }),
        files: Type.Array(
          Type.String({
            minLength: 1,
            description:
              'Literal worktree-relative .test.ts, .test.tsx, .spec.ts, or .spec.tsx path.',
          }),
          {
            minItems: 1,
            description:
              'Required test files as worktree-relative paths; keep the same files through the cycle, including full runs.',
          },
        ),
        scope: Type.Union([Type.Literal('focused'), Type.Literal('full')], {
          description:
            'Use focused for the exact test in files to prove RED and GREEN; use full for all tests at the end to verify every recorded RED.',
        }),
      }),
      async execute(_id, params, _signal, _update, ctx) {
        const { scope, ...behavior } = params;
        const details = await store.run(ctx.cwd, behavior, scope);
        const report =
          details.kind === 'inputs-changed' ? null : details.evidence.latestRun?.report;
        const missing =
          scope === 'full' && report && 'tests' in report
            ? details.evidence.reds.find(
                ({ behavior: required, record }) =>
                  record.report.kind === 'fail' &&
                  record.report.tests.some(
                    (test) =>
                      test.status === 'failed' &&
                      test.fullname === required.testFullName &&
                      required.files.some(
                        (file) => resolve(ctx.cwd, file) === resolve(ctx.cwd, test.file),
                      ) &&
                      !report.tests.some(
                        (result) =>
                          result.fullname === test.fullname &&
                          resolve(ctx.cwd, result.file) === resolve(ctx.cwd, test.file) &&
                          (result.status === 'passed' || result.status === 'failed'),
                      ),
                  ),
              )?.behavior
            : undefined;
        let next: string | undefined;
        const call = `run_tests ${JSON.stringify({ ...behavior, scope })}`;
        if (details.kind === 'inputs-changed')
          next = `Inputs changed during the run; no evidence was recorded. Stop concurrent edits, then call ${call}.`;
        else if (report && hasAmbiguousIdentity(ctx.cwd, behavior, report))
          next = `More than one test in the same file has the full name ${JSON.stringify(behavior.testFullName)}, so the report cannot identify it and no evidence was recorded. Give each test a unique full name, then call ${call}.`;
        else if (scope === 'focused' && details.kind === 'pass' && details.phase === 'locked')
          next = `The test does not fail yet; the behavior may already be implemented. Write a test that fails before the fix, then call ${call}.`;
        else if (missing)
          next = `A required RED test is skipped or missing: ${JSON.stringify(missing.testFullName)} in ${JSON.stringify(missing.files)}. Restore that test so it runs and passes, then call ${call}.`;
        const output = JSON.stringify({
          kind: details.kind,
          phase: details.phase,
          implementationAllowed: details.implementationAllowed,
          next,
          report,
        });
        const text = output.length > 4000 ? `${output.slice(0, 3980)}\n[truncated]` : output;
        return { content: [{ type: 'text', text }], details };
      },
    }),
  );
}
