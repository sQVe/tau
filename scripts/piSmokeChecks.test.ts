import { expect, it } from 'vitest';

import {
  smokeCodemodeMarker,
  smokeCommitFile,
  smokeCommitSubject,
  smokeFailures,
  smokeTestName,
} from './piSmokeChecks.ts';
import type { GitFacts } from './piSmokeChecks.ts';

const call = (toolName: string, text: string, isError = false, details?: unknown) =>
  JSON.stringify({
    type: 'tool_execution_end',
    toolName,
    isError,
    result: { content: [{ type: 'text', text }], details },
  });

const runTests = (freshness: string | undefined, kind = 'pass', status = 'passed') =>
  call('run_tests', `${kind} · focused · fresh\n1 test`, false, {
    kind,
    ...(freshness === undefined ? {} : { freshness }),
    report: { kind, tests: [{ fullname: smokeTestName, status }] },
  });

const codemodeId = 'call_1|ctc_1';

const smokeScript =
  'const result = await tools.bash({ command: "printf tau-smoke-%s $((7000+431))" });';

const codemodeStart = (code = smokeScript) =>
  JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: codemodeId,
    toolName: 'codemode',
    args: { code },
  });

const bashEnd = (output: string, parentToolCallId = codemodeId, isError = false) =>
  JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: `${codemodeId}/1`,
    toolName: 'bash',
    result: { content: [{ type: 'text', text: output }], structuredContent: { output } },
    isError,
    parentToolCallId,
  });

const codemodeEnd = (text: string) =>
  JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: codemodeId,
    toolName: 'codemode',
    result: { content: [{ type: 'text', text }], details: { calls: [] } },
    isError: false,
  });

const edit = call('edit', 'Replaced 1 block.\nHint: Test results are stale; rerun run_tests.');
const commit = call('commit', 'Committed.');

const codemodeLines = (nested: string, result = smokeCodemodeMarker, code = smokeScript) => [
  codemodeStart(code),
  nested,
  codemodeEnd(result),
];

const codemode = codemodeLines(bashEnd(smokeCodemodeMarker));

const committed: GitFacts = {
  commits: [
    { subject: smokeCommitSubject, files: [smokeCommitFile] },
    { subject: 'chore: initial', files: ['package.json'] },
  ],
};

const passing = [runTests('fresh'), edit, commit, ...codemode];

it.each([
  { name: 'all checks pass', lines: passing, git: committed, failures: [] },
  {
    name: 'fresh text but freshness unknown in details',
    lines: [runTests('unknown'), edit, commit, ...codemode],
    git: committed,
    failures: ['run_tests freshness after a run: expected fresh, got unknown'],
  },
  {
    name: 'no stale hint after an edit',
    lines: [runTests('fresh'), call('edit', 'Replaced 1 block.'), commit, ...codemode],
    git: committed,
    failures: [
      'run_tests freshness after an edit: expected stale hint on an edit result after the fresh run, got none',
    ],
  },
  {
    name: 'missing codemode call',
    lines: [runTests('fresh'), edit, commit],
    git: committed,
    failures: [
      'tool calls: expected run_tests, edit, commit, codemode, got run_tests, edit, commit',
    ],
  },
  {
    name: 'errored commit call and no commit',
    lines: [runTests('fresh'), edit, call('commit', 'hook failed', true), ...codemode],
    git: { commits: [{ subject: 'chore: initial', files: ['package.json'] }] },
    failures: [
      'commit tool call: expected no error, got error: hook failed',
      `commit in the scratch repository: expected subject "${smokeCommitSubject}", got chore: initial`,
    ],
  },
  {
    name: 'commit with the wrong files',
    lines: passing,
    git: { commits: [{ subject: smokeCommitSubject, files: ['src/answer.test.ts'] }] },
    failures: [
      `commit files in the scratch repository: expected ${smokeCommitFile}, got src/answer.test.ts`,
    ],
  },
  {
    name: 'codemode result without the marker',
    lines: [
      runTests('fresh'),
      edit,
      commit,
      ...codemodeLines(bashEnd(smokeCodemodeMarker), 'nothing'),
    ],
    git: committed,
    failures: [
      `codemode bash marker: expected ${smokeCodemodeMarker} in the result, got "nothing"`,
    ],
  },
  {
    name: 'failed run with fresh freshness',
    lines: [runTests('fresh', 'fail', 'failed'), edit, commit, ...codemode],
    git: committed,
    failures: [
      `run_tests result: expected pass with "${smokeTestName}" passed, got fail with 1 listed tests`,
    ],
  },
  {
    name: 'run that did not run the selected test',
    lines: [
      call('run_tests', 'pass · focused · fresh', false, {
        freshness: 'fresh',
        report: { kind: 'pass', tests: [] },
      }),
      edit,
      commit,
      ...codemode,
    ],
    git: committed,
    failures: [
      `run_tests result: expected pass with "${smokeTestName}" passed, got pass with 0 listed tests`,
    ],
  },
  {
    name: 'marker without nested bash evidence',
    lines: [runTests('fresh'), edit, commit, codemodeStart(), codemodeEnd(smokeCodemodeMarker)],
    git: committed,
    failures: [
      `codemode nested bash call: expected a bash end event with parent ${codemodeId}, got none`,
    ],
  },
  {
    name: 'nested bash output lacks the marker while the result has it',
    lines: [runTests('fresh'), edit, commit, ...codemodeLines(bashEnd('other'))],
    git: committed,
    failures: [
      `codemode nested bash output: expected ${smokeCodemodeMarker} without error, got "other"`,
    ],
  },
  {
    name: 'bash call whose parent is not the codemode call',
    lines: [
      runTests('fresh'),
      edit,
      commit,
      ...codemodeLines(bashEnd(smokeCodemodeMarker, 'call_2|ctc_2')),
    ],
    git: committed,
    failures: [
      `codemode nested bash call: expected a bash end event with parent ${codemodeId}, got none`,
    ],
  },
  {
    name: 'nested bash call with an error',
    lines: [
      runTests('fresh'),
      edit,
      commit,
      ...codemodeLines(bashEnd(smokeCodemodeMarker, codemodeId, true)),
    ],
    git: committed,
    failures: [
      `codemode nested bash output: expected ${smokeCodemodeMarker} without error, got "${smokeCodemodeMarker}"`,
    ],
  },
  {
    name: 'script contains the literal marker',
    lines: [
      runTests('fresh'),
      edit,
      commit,
      ...codemodeLines(
        bashEnd(smokeCodemodeMarker),
        smokeCodemodeMarker,
        `return "${smokeCodemodeMarker}";`,
      ),
    ],
    git: committed,
    failures: [
      `codemode script: expected no literal ${smokeCodemodeMarker}, got "return \\"${smokeCodemodeMarker}\\";"`,
    ],
  },
  {
    name: 'codemode without a start event',
    lines: [
      runTests('fresh'),
      edit,
      commit,
      bashEnd(smokeCodemodeMarker),
      codemodeEnd(smokeCodemodeMarker),
    ],
    git: committed,
    failures: [
      `codemode script: expected a start event for ${codemodeId} with args.code, got none`,
    ],
  },
  {
    name: 'fresh text but freshness missing from details',
    lines: [runTests(undefined), edit, commit, ...codemode],
    git: committed,
    failures: ['run_tests freshness after a run: expected fresh, got missing'],
  },
  {
    name: 'stale edit before the fresh run',
    lines: [edit, runTests('fresh'), commit, ...codemode],
    git: committed,
    failures: [
      'tool calls: expected run_tests, edit, commit, codemode, got edit, run_tests, commit, codemode',
      'run_tests freshness after an edit: expected stale hint on an edit result after the fresh run, got none',
    ],
  },
  {
    name: 'extra edit after the commit',
    lines: [runTests('fresh'), edit, commit, edit, ...codemode],
    git: committed,
    failures: [
      'tool calls: expected run_tests, edit, commit, codemode, got run_tests, edit, commit, edit, codemode',
    ],
  },
  {
    name: 'other top-level tools between the checked calls',
    lines: [
      runTests('fresh'),
      edit,
      call('read', 'file'),
      call('bash', 'clean'),
      commit,
      ...codemode,
    ],
    git: committed,
    failures: [],
  },
  {
    name: 'ignores lines that are not tool events',
    lines: ['not json', JSON.stringify({ type: 'turn_end' }), ...passing],
    git: committed,
    failures: [],
  },
])('$name', ({ lines, git, failures }) => {
  expect(smokeFailures(lines, git)).toEqual(failures);
});
