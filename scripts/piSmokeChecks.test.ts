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

const runTests = (freshness: string, kind = 'pass', status = 'passed') =>
  call('run_tests', `${kind} · focused · ${freshness}\n1 test`, false, {
    kind,
    freshness,
    report: { kind, tests: [{ fullname: smokeTestName, status }] },
  });

const edit = call('edit', 'Replaced 1 block.\nHint: Test results are stale; rerun run_tests.');
const commit = call('commit', 'Committed.');
const nestedBash = { calls: [{ name: 'bash', status: 'ok' }] };
const codemode = call('codemode', smokeCodemodeMarker, false, nestedBash);

const committed: GitFacts = {
  commits: [
    { subject: smokeCommitSubject, files: [smokeCommitFile] },
    { subject: 'chore: initial', files: ['package.json'] },
  ],
};

const passing = [runTests('fresh'), edit, commit, codemode];

it.each([
  { name: 'all checks pass', lines: passing, git: committed, failures: [] },
  {
    name: 'freshness unknown after a run',
    lines: [runTests('unknown'), edit, commit, codemode],
    git: committed,
    failures: ['run_tests freshness after a run: expected fresh, got unknown'],
  },
  {
    name: 'no stale hint after an edit',
    lines: [runTests('fresh'), call('edit', 'Replaced 1 block.'), commit, codemode],
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
      'codemode tool call: expected at least one call, got none (calls: run_tests, edit, commit)',
    ],
  },
  {
    name: 'errored commit call and no commit',
    lines: [runTests('fresh'), edit, call('commit', 'hook failed', true), codemode],
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
    lines: [runTests('fresh'), edit, commit, call('codemode', 'nothing', false, nestedBash)],
    git: committed,
    failures: [
      `codemode bash marker: expected ${smokeCodemodeMarker} in the result, got "nothing"`,
    ],
  },
  {
    name: 'failed run with fresh freshness',
    lines: [runTests('fresh', 'fail', 'failed'), edit, commit, codemode],
    git: committed,
    failures: [
      `run_tests result: expected pass with "${smokeTestName}" passed, got fail with 1 listed tests`,
    ],
  },
  {
    name: 'run that did not run the selected test',
    lines: [
      call('run_tests', 'pass · focused · fresh', false, { report: { kind: 'pass', tests: [] } }),
      edit,
      commit,
      codemode,
    ],
    git: committed,
    failures: [
      `run_tests result: expected pass with "${smokeTestName}" passed, got pass with 0 listed tests`,
    ],
  },
  {
    name: 'marker without nested bash evidence',
    lines: [runTests('fresh'), edit, commit, call('codemode', smokeCodemodeMarker)],
    git: committed,
    failures: ['codemode nested bash call: expected one bash call with status ok, got none'],
  },
  {
    name: 'stale edit before the fresh run',
    lines: [edit, runTests('fresh'), commit, codemode],
    git: committed,
    failures: [
      'run_tests freshness after an edit: expected stale hint on an edit result after the fresh run, got none',
    ],
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
