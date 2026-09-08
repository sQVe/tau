import { isAbsolute, relative, resolve } from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { guardToolCall } from './guard.js';
import type { RunnerResult } from './runner/types.js';
import { MAX_FAILURES } from './runner/types.js';
import { ambiguousFiles, createEvidenceStore } from './state.js';

const MAX_SUMMARY_CHARS = 2000;

const displayPath = (cwd: string, file: string) => (isAbsolute(file) ? relative(cwd, file) : file);

const summarize = (
  cwd: string,
  header: {
    kind: string;
    phase: string;
    implementationAllowed: boolean;
    notice: string | undefined;
  },
  next: string | undefined,
  report: RunnerResult | null | undefined,
): string => {
  const lines = [
    `${header.kind} · phase ${header.phase} · implementation ${header.implementationAllowed ? 'allowed' : 'blocked'}`,
  ];
  if (header.notice != null) lines.push(`Notice: ${header.notice}`);
  if (next != null) lines.push(`Next: ${next}`);
  if (report != null && 'message' in report) lines.push(report.message);
  if (report != null && 'tests' in report) {
    const count = (...statuses: string[]) =>
      report.tests.filter((test) => statuses.includes(test.status)).length;
    lines.push(
      `${count('passed')} passed, ${count('failed')} failed, ${count('skipped', 'todo')} skipped`,
    );
  }
  const failures = report != null && 'failures' in report ? report.failures : [];
  let shown = 0;
  for (const failure of failures.slice(0, MAX_FAILURES)) {
    const entry = `✗ ${displayPath(cwd, failure.file)} › ${failure.fullname}\n    ${failure.message}`;
    if ([...lines, entry].join('\n').length > MAX_SUMMARY_CHARS - 60) break;
    lines.push(entry);
    shown += 1;
  }
  if (failures.length > shown) lines.push(`+${failures.length - shown} more`);
  if (report != null && 'truncated' in report && report.truncated)
    lines.push('further failures were not collected');
  const text = lines.join('\n');
  return text.length > MAX_SUMMARY_CHARS ? `${text.slice(0, MAX_SUMMARY_CHARS - 12)}\n[cut]` : text;
};

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
        'Only files matching the production globs are gated, and a notice string says the gate is off while no test runner resolves from the worktree. ' +
        'A next string explains recovery when needed; the text is a short summary with counts and failing tests, and details carries the full report.',
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
      async execute(_id, params, signal, _update, ctx) {
        const { scope, ...behavior } = params;
        const details = await store.run(ctx.cwd, behavior, scope, signal);
        const report =
          details.kind === 'inputs-changed' || details.kind === 'cancelled'
            ? null
            : details.evidence.latestRun?.report;
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
        const ambiguous = report ? ambiguousFiles(ctx.cwd, behavior, report) : [];
        const duplicatedRed =
          scope === 'full' && report
            ? details.evidence.reds
                .map(({ behavior: required }) => ({
                  required,
                  files: ambiguousFiles(ctx.cwd, required, report),
                }))
                // The ambiguous branches already cover the current behavior's own files, so an
                // earlier RED sharing its full name in another file still has to be named here.
                .find((entry) => entry.files.length > 0)
            : undefined;
        let next: string | undefined;
        const call = `run_tests ${JSON.stringify({ ...behavior, scope })}`;
        if (details.kind === 'inputs-changed')
          next = `Inputs changed during the run; no evidence was recorded. Stop concurrent edits, then call ${call}.`;
        else if (
          ambiguous.length > 0 &&
          ambiguous.length < behavior.files.length &&
          details.phase !== 'locked'
        )
          next = `More than one test in ${JSON.stringify(ambiguous)} has the full name ${JSON.stringify(behavior.testFullName)}, so that file proves nothing; the evidence recorded from the other required files stands and the phase is ${details.phase}. Give each test a unique full name, then call ${call}.`;
        else if (ambiguous.length > 0)
          next = `More than one test in ${JSON.stringify(ambiguous)} has the full name ${JSON.stringify(behavior.testFullName)}, so the report cannot identify it and no evidence was recorded. Give each test a unique full name, then call ${call}.`;
        else if (scope === 'focused' && details.kind === 'pass' && details.phase === 'locked')
          next = `The test does not fail yet; the behavior may already be implemented. Write a test that fails before the fix, then call ${call}.`;
        else if (missing)
          next = `A required RED test is skipped or missing: ${JSON.stringify(missing.testFullName)} in ${JSON.stringify(missing.files)}. Restore that test so it runs and passes, then call ${call}.`;
        else if (duplicatedRed)
          next = `An earlier RED test can no longer be identified: more than one test in ${JSON.stringify(duplicatedRed.files)} has its full name ${JSON.stringify(duplicatedRed.required.testFullName)}, so the full run cannot verify it. Rename the duplicate so each full name is unique, then call ${call}.`;
        return {
          content: [{ type: 'text', text: summarize(ctx.cwd, details, next, report) }],
          details,
        };
      },
    }),
  );
}
