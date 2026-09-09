import { execFile as execFileCallback } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { guardToolCall } from './guard.js';
import type { RunnerResult, TestResult } from './runner/types.js';
import { MAX_FAILURES } from './runner/types.js';
import { ambiguousFiles, createEvidenceStore, testNames } from './state.js';
import type { Behavior, EvidenceState, Phase } from './types.js';

const MAX_SUMMARY_CHARS = 2000;

const execFile = promisify(execFileCallback);

const STATUS_KEY = 'tdd';

const statusText = (state: {
  phase: Phase;
  evidence: { active: Behavior | null };
  notice: string | undefined;
}) =>
  `TDD ${state.notice == null ? state.phase : 'off'}: ${state.evidence.active?.behavior ?? 'no behavior'}`;

const displayPath = (cwd: string, file: string) => (isAbsolute(file) ? relative(cwd, file) : file);

// A notice means the gate is off, and the guard lets production writes through in every phase.
const implementationState = (allowed: boolean, notice: string | undefined) => {
  if (notice != null) return 'allowed (gate off)';
  return allowed ? 'allowed' : 'blocked';
};

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
  redCoverage?: string,
): string => {
  const lines = [
    ...(header.notice == null ? [] : [`Notice: ${header.notice}`]),
    `${header.kind} · phase ${header.phase} · implementation ${implementationState(header.implementationAllowed, header.notice)}`,
  ];
  if (next != null) lines.push(`Next: ${next}`);
  if (report != null && 'message' in report) lines.push(report.message);
  if (report != null && 'tests' in report) {
    const count = (...statuses: string[]) =>
      report.tests.filter((test) => statuses.includes(test.status)).length;
    lines.push(
      `${count('passed')} passed, ${count('failed')} failed, ${count('skipped', 'todo')} skipped`,
    );
  }
  if (redCoverage != null) lines.push(redCoverage);
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

// A test whose quoted title already sits in the committed file predates this task. Longer
// suffixes of the full name are tried first, since describe names prefix it.
// ponytail: substring match; it.each templates and dynamic titles read as new.
const committedTitles = async (cwd: string, file: string): Promise<string | null> => {
  try {
    const { stdout } = await execFile(
      'git',
      ['show', `HEAD:${relative(cwd, resolve(cwd, file)).split(sep).join('/')}`],
      {
        cwd,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return stdout;
  } catch {
    return null;
  }
};

// Parameterized titles hold `%s` or `$name` placeholders that the report has already filled in.
const templatePatterns = (content: string): RegExp[] =>
  [...content.matchAll(/(['"`])([^'"`\n]*)\1/g)]
    .map((match) => match[2] ?? '')
    .filter((title) => /%[sdifjo#$]|\$[\w.]+/.test(title))
    .map(
      (title) =>
        new RegExp(
          `^${title
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/%[sdifjo#]|\\\$[\w.]+/g, '.+?')
            .replace(/%%/g, '%')}$`,
        ),
    );

const titledIn = (content: string, fullname: string) => {
  const words = fullname.split(' ');
  const patterns = templatePatterns(content);
  return words.some((_word, index) => {
    const suffix = words.slice(index).join(' ');
    return (
      [`'${suffix}'`, `"${suffix}"`, `\`${suffix}\``].some((quoted) => content.includes(quoted)) ||
      patterns.some((pattern) => pattern.test(suffix))
    );
  });
};

// The gate proves one named test per cycle, so tests added alongside it in the same files pass on
// their first run without ever failing. The full run names them so the reader can judge.
const describeRedCoverage = async (
  cwd: string,
  evidence: Pick<EvidenceState, 'reds' | 'proven'>,
  tests: TestResult[],
): Promise<string | undefined> => {
  const sameFile = (left: string, right: string) => resolve(cwd, left) === resolve(cwd, right);
  const requiredFiles = [
    ...new Set(
      evidence.reds.flatMap(({ behavior }) => behavior.files.map((file) => resolve(cwd, file))),
    ),
  ];
  const committed = new Map(
    await Promise.all(
      requiredFiles.map(async (file) => [file, await committedTitles(cwd, file)] as const),
    ),
  );
  const required = tests.filter(
    (test) =>
      (test.status === 'passed' || test.status === 'failed') &&
      requiredFiles.some((file) => sameFile(file, test.file)),
  );
  if (required.length === 0) return undefined;
  const proven = (test: TestResult) =>
    evidence.proven.some(
      (known) => known.fullname === test.fullname && sameFile(known.file, test.file),
    );
  const preexisting = (test: TestResult) => {
    const content = committed.get(resolve(cwd, test.file));
    return content != null && titledIn(content, test.fullname);
  };
  const unproven = required.filter((test) => !proven(test) && !preexisting(test));
  const renewedFiles = evidence.reds.flatMap(({ behavior, edited }) =>
    edited ? behavior.files : [],
  );
  const edited = required.filter(
    (test) => proven(test) && renewedFiles.some((file) => sameFile(file, test.file)),
  );
  const names = (listed: TestResult[]) =>
    listed
      .slice(0, 3)
      .map((test) => `${displayPath(cwd, test.file)} › ${test.fullname}`)
      .join(', ') + (listed.length > 3 ? ` and ${listed.length - 3} more` : '');
  return [
    `${required.length - unproven.length} of ${required.length} tests in the required files were proven RED or committed before`,
    ...(unproven.length === 0 ? [] : [`never failed: ${names(unproven)}`]),
    ...(edited.length === 0 ? [] : [`edited after RED: ${names(edited)}`]),
  ].join('; ');
};

export default function tddExtension(pi: ExtensionAPI) {
  const store = createEvidenceStore();
  // The guard reads the state before the write lands, so the footer trails a write that
  // invalidates evidence by one tool call. A read of its own here would double the hashing.
  pi.on('tool_call', (event, ctx) =>
    guardToolCall(event, ctx.cwd, store, (state) => {
      ctx.ui.setStatus(STATUS_KEY, statusText(state));
    }),
  );
  const refreshStatus = async (ctx: ExtensionContext) => {
    ctx.ui.setStatus(STATUS_KEY, statusText(await store.read(ctx.cwd)));
  };
  pi.on('session_start', (_event, ctx) => refreshStatus(ctx));
  // `session_start` fires once per process, so /new, resume, and fork need their own refresh or
  // the footer keeps reporting the phase of the session the user left.
  pi.on('session_before_switch', async (_event, ctx) => {
    await refreshStatus(ctx);
    return undefined;
  });
  pi.on('session_before_fork', async (_event, ctx) => {
    await refreshStatus(ctx);
    return undefined;
  });
  pi.registerCommand('tdd', {
    description: 'Turn the TDD gate on or off, or report its state: /tdd on|off|status.',
    handler: async (args, ctx) => {
      const argument = args.trim() || 'status';
      if (argument !== 'on' && argument !== 'off' && argument !== 'status') {
        ctx.ui.notify(`Unknown argument ${argument}; use /tdd on|off|status`, 'warning');
        return;
      }
      const state =
        argument === 'status' ? await store.read(ctx.cwd) : await store.setGate(ctx.cwd, argument);
      ctx.ui.setStatus(STATUS_KEY, statusText(state));
      let gate = 'on';
      if (state.evidence.gateOff != null) gate = `off since ${state.evidence.gateOff.since}`;
      else if (state.notice != null) gate = `off: ${state.notice}`;
      ctx.ui.notify(
        `TDD gate ${gate}\nPhase ${state.phase}; production writes ${state.implementationAllowed || state.notice != null ? 'allowed' : 'blocked'}.`,
      );
    },
  });
  pi.registerTool(
    defineTool({
      name: 'run_tests',
      label: 'Run tests',
      description:
        'Name a behavior, its test files, and the exact Vitest full name: describe names followed by the it name, joined with spaces, for example "outer inner works", or an array of such names when several small tests prove one behavior together. ' +
        'Create a missing production module with write and content "" so the test can import it; nonempty production writes still require RED. Run scope "focused" to prove RED before editing production files, run focused again for GREEN after the fix, then run scope "full" at the end for verified. ' +
        'Editing a required test file before GREEN re-locks the gate; a focused pass accepts the edit and the full run reports it. GREEN permits cleanup, but changed inputs invalidate passing evidence. ' +
        'Skipped and deleted tests never count. ' +
        'Returns kind (run outcome), phase (locked: no valid RED; red: failing test proven; green: that test passed; verified: full run passed with every RED test present and passing), implementationAllowed (true in red and green), and report (test results, null if inputs changed). ' +
        'Only files matching the production globs are gated, and a notice string says the gate is off while no test runner resolves from the worktree or the user turned it off with /tdd off. ' +
        'A next string explains recovery when needed; the text is a short summary with counts and failing tests, and details carries the full report.',
      parameters: Type.Object({
        behavior: Type.String({
          minLength: 1,
          description:
            'Name the behavior to implement; keep it unchanged through RED, GREEN, and full verification.',
        }),
        testFullName: Type.Union(
          [
            Type.String({ minLength: 1 }),
            Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          ],
          {
            description:
              'Exact Vitest full name: describe names then the it name, joined with spaces, not " > "; for example "outer inner works". Give an array when one behavior is proven by several small tests; every one must fail in RED and pass in GREEN. Use the same names for focused and full runs.',
          },
        ),
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
        ctx.ui.setStatus(STATUS_KEY, statusText(details));
        const report =
          details.kind === 'inputs-changed' || details.kind === 'cancelled' ? null : details.report;
        const missing =
          scope === 'full' && report && 'tests' in report
            ? details.evidence.reds.find(
                ({ behavior: required, report: redReport }) =>
                  redReport.kind === 'fail' &&
                  redReport.tests.some(
                    (test) =>
                      test.status === 'failed' &&
                      testNames(required).includes(test.fullname) &&
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
        else if (
          scope === 'focused' &&
          details.kind === 'pass' &&
          details.phase === 'locked' &&
          details.staleSinceRed.length > 0
        )
          next = `${details.staleSinceRed.join(', ')} changed after RED and before GREEN, so that proof no longer matches. Remove the production change so the test fails again, call ${call} to prove RED, then put the change back.`;
        else if (scope === 'focused' && details.kind === 'pass' && details.phase === 'locked')
          next = `The test does not fail yet; the behavior may already be implemented. Write a test that fails before the fix, then call ${call}.`;
        else if (missing)
          next = `A required RED test is skipped or missing: ${JSON.stringify(missing.testFullName)} in ${JSON.stringify(missing.files)}. Restore that test so it runs and passes, then call ${call}.`;
        else if (duplicatedRed)
          next = `An earlier RED test can no longer be identified: more than one test in ${JSON.stringify(duplicatedRed.files)} has its full name ${JSON.stringify(duplicatedRed.required.testFullName)}, so the full run cannot verify it. Rename the duplicate so each full name is unique, then call ${call}.`;
        const redCoverage =
          scope === 'full' && report && 'tests' in report
            ? await describeRedCoverage(ctx.cwd, details.evidence, report.tests)
            : undefined;
        return {
          content: [{ type: 'text', text: summarize(ctx.cwd, details, next, report, redCoverage) }],
          details,
        };
      },
    }),
  );
}
