import { describe, expect, it } from 'vitest';

import {
  assertion,
  focusedRun,
  fullRun,
  reportOf,
  testFile,
  testFilePath,
  validReport,
  worktree,
} from '../fixtures/reportBuilders.js';
import { classifyReport, maximumFailures, unparseableReportResult } from './report.js';
import type { VitestReport } from './report.js';
import type { RunnerResult, RunTestsInput } from './types.js';

interface ClassificationCase {
  name: string;
  input: RunTestsInput;
  exitCode: number | null;
  report: VitestReport;
  version: string;
  expected: RunnerResult;
}

interface MessageCase {
  name: string;
  failureMessages: string[];
  cwd?: string;
  expected: string;
}

interface UnparseableCase {
  name: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  expected: RunnerResult;
}

const failuresOf = (result: RunnerResult) => (result.kind === 'fail' ? result.failures : []);

const messageOf = (failureMessages: string[], cwd = worktree) => {
  const result = classifyReport(
    fullRun(cwd),
    1,
    reportOf([testFile([assertion({ status: 'failed', failureMessages })])]),
    '4.1.11',
  );

  return failuresOf(result)[0]?.message;
};

describe('classifyReport', () => {
  it.each<ClassificationCase>([
    {
      name: 'pass when every selected test passed',
      input: focusedRun(['suite works']),
      exitCode: 0,
      report: validReport,
      version: '4.1.11',
      expected: {
        kind: 'pass',
        tests: [{ file: testFilePath, fullname: 'suite works', status: 'passed', durationMs: 3 }],
      },
    },
    {
      name: 'fail with the assertion location when a test failed, even on exit 1',
      input: focusedRun(['suite works']),
      exitCode: 1,
      report: reportOf([
        testFile([
          assertion({
            status: 'failed',
            failureMessages: ['AssertionError: expected 1 to be 2\n    at /repo/a.test.ts:5:3'],
          }),
        ]),
      ]),
      version: '4.1.11',
      expected: {
        kind: 'fail',
        failures: [
          {
            file: testFilePath,
            fullname: 'suite works',
            message: 'AssertionError: expected 1 to be 2 (a.test.ts:5)',
          },
        ],
        tests: [{ file: testFilePath, fullname: 'suite works', status: 'failed', durationMs: 3 }],
        truncated: false,
      },
    },
    {
      name: 'compile-error on a nonzero exit with a passing report',
      input: fullRun(),
      exitCode: 1,
      report: validReport,
      version: '4.1.11',
      expected: {
        kind: 'compile-error',
        message: 'vitest did not complete successfully',
        tests: [{ file: testFilePath, fullname: 'suite works', status: 'passed', durationMs: 3 }],
      },
    },
    {
      name: 'no-tests-collected when the report has no tests',
      input: fullRun(),
      exitCode: 0,
      report: reportOf([]),
      version: '4.1.11',
      expected: { kind: 'no-tests-collected', tests: [] },
    },
    {
      name: 'no-tests-collected when a file lists no assertions',
      input: fullRun(),
      exitCode: 0,
      report: reportOf([testFile([])]),
      version: '4.1.11',
      expected: { kind: 'no-tests-collected', tests: [] },
    },
    {
      name: 'no-tests-collected when every test was skipped',
      input: fullRun(),
      exitCode: 0,
      report: reportOf([testFile([assertion({ status: 'skipped' })])]),
      version: '4.1.11',
      expected: {
        kind: 'no-tests-collected',
        tests: [{ file: testFilePath, fullname: 'suite works', status: 'skipped', durationMs: 3 }],
      },
    },
    {
      name: 'no-tests-collected with a message when the exact filter matches nothing',
      input: focusedRun(['missing']),
      exitCode: 0,
      report: validReport,
      version: '4.1.11',
      expected: {
        kind: 'no-tests-collected',
        tests: [],
        message: [
          'No tests matched the exact name filter. Vitest 4.1.11 joins nested names with " ".',
          'Use the complete describe and test names. Do not restructure tests or broaden the filter.',
          'Collected names (up to 5):\na.test.ts: suite works',
        ].join('\n'),
      },
    },
    {
      name: 'no-tests-collected with a message when the filter matches nothing and no names exist',
      input: focusedRun(['missing']),
      exitCode: 0,
      report: reportOf([]),
      version: '4.1.11',
      expected: {
        kind: 'no-tests-collected',
        tests: [],
        message: [
          'No tests matched the exact name filter. Vitest 4.1.11 joins nested names with " ".',
          'Use the complete describe and test names. Do not restructure tests or broaden the filter.',
          'No names were reported; check the selected files and runner diagnostics.',
        ].join('\n'),
      },
    },
    {
      name: 'no-tests-collected when the only selected test was skipped',
      input: focusedRun(['suite works']),
      exitCode: 0,
      report: reportOf([testFile([assertion({ status: 'skipped' })])]),
      version: '4.1.11',
      expected: {
        kind: 'no-tests-collected',
        tests: [{ file: testFilePath, fullname: 'suite works', status: 'skipped', durationMs: 3 }],
      },
    },
    {
      name: 'pass with a Vitest 5 " > " name in the filter',
      input: focusedRun(['suite > works']),
      exitCode: 0,
      report: validReport,
      version: '5.0.1',
      expected: {
        kind: 'pass',
        tests: [{ file: testFilePath, fullname: 'suite > works', status: 'passed', durationMs: 3 }],
      },
    },
    {
      name: 'fail with a file-level message when a file failed without an assertion',
      input: fullRun(),
      exitCode: 1,
      report: reportOf([
        testFile([], { status: 'failed', message: 'Cannot find module ./missing.js' }),
      ]),
      version: '4.1.11',
      expected: {
        kind: 'fail',
        failures: [
          {
            file: testFilePath,
            fullname: '<file>',
            message: 'Cannot find module ./missing.js',
          },
        ],
        tests: [],
        truncated: false,
      },
    },
    {
      name: 'fail with a file-level error even when every assertion passed',
      input: fullRun(),
      exitCode: 1,
      report: reportOf([
        testFile([assertion({ fullName: 'passes' })], {
          status: 'failed',
          message: 'teardown boom',
        }),
      ]),
      version: '4.1.11',
      expected: {
        kind: 'fail',
        failures: [{ file: testFilePath, fullname: '<file>', message: 'teardown boom' }],
        tests: [{ file: testFilePath, fullname: 'passes', status: 'passed', durationMs: 3 }],
        truncated: false,
      },
    },
    {
      name: 'fail with a default message for a failed file with no message and no failed assertion',
      input: fullRun(),
      exitCode: 1,
      report: reportOf([testFile([assertion()], { status: 'failed' })]),
      version: '4.1.11',
      expected: {
        kind: 'fail',
        failures: [
          {
            file: testFilePath,
            fullname: '<file>',
            message: 'File setup or load failed; inspect the saved runner diagnostics.',
          },
        ],
        tests: [{ file: testFilePath, fullname: 'suite works', status: 'passed', durationMs: 3 }],
        truncated: false,
      },
    },
    {
      name: 'fail with only the failed files and assertions of a failing run',
      input: fullRun(),
      exitCode: 1,
      report: reportOf([
        testFile([assertion({ title: 'passes' })], { name: '/repo/passing.test.ts' }),
        testFile(
          [
            assertion({
              title: 'fails',
              status: 'failed',
              failureMessages: ['expected 1 to be 2'],
            }),
          ],
          {
            name: '/repo/failing.test.ts',
          },
        ),
      ]),
      version: '4.1.11',
      expected: {
        kind: 'fail',
        failures: [
          { file: '/repo/failing.test.ts', fullname: 'suite fails', message: 'expected 1 to be 2' },
        ],
        tests: [
          {
            file: '/repo/passing.test.ts',
            fullname: 'suite passes',
            status: 'passed',
            durationMs: 3,
          },
          {
            file: '/repo/failing.test.ts',
            fullname: 'suite fails',
            status: 'failed',
            durationMs: 3,
          },
        ],
        truncated: false,
      },
    },
    {
      name: 'fail with a file-level error ahead of a failing assertion in the same file',
      input: fullRun(),
      exitCode: 1,
      report: reportOf([
        testFile([assertion({ status: 'failed', failureMessages: ['expected 1 to be 2'] })], {
          status: 'failed',
          message: 'teardown boom',
        }),
      ]),
      version: '4.1.11',
      expected: {
        kind: 'fail',
        failures: [
          { file: testFilePath, fullname: '<file>', message: 'teardown boom' },
          { file: testFilePath, fullname: 'suite works', message: 'expected 1 to be 2' },
        ],
        tests: [{ file: testFilePath, fullname: 'suite works', status: 'failed', durationMs: 3 }],
        truncated: false,
      },
    },
    {
      name: 'fail with a file-level error reduced to its headline and worktree frame',
      input: fullRun(),
      exitCode: 1,
      report: reportOf([
        testFile([], {
          status: 'failed',
          message: 'ReferenceError: foo is not defined\n    at /repo/a.test.ts:2:9\n    at more',
        }),
      ]),
      version: '4.1.11',
      expected: {
        kind: 'fail',
        failures: [
          {
            file: testFilePath,
            fullname: '<file>',
            message: 'ReferenceError: foo is not defined (a.test.ts:2)',
          },
        ],
        tests: [],
        truncated: false,
      },
    },
    {
      name: 'pass with only the tests the filter selected',
      input: focusedRun(['suite works']),
      exitCode: 0,
      report: reportOf([testFile([assertion(), assertion({ title: 'other' })])]),
      version: '4.1.11',
      expected: {
        kind: 'pass',
        tests: [{ file: testFilePath, fullname: 'suite works', status: 'passed', durationMs: 3 }],
      },
    },
  ])('returns $name', ({ input, exitCode, report, version, expected }) => {
    expect(classifyReport(input, exitCode, report, version)).toEqual(expected);
  });

  it('caps failures at maximumFailures and marks the result truncated', () => {
    const titles = Array.from({ length: 15 }, (_, index) => `case ${index}`);

    const assertions = titles.map((title) =>
      assertion({ status: 'failed', title, failureMessages: ['boom'] }),
    );

    const result = classifyReport(fullRun(), 1, reportOf([testFile(assertions)]), '4.1.11');

    expect(result).toMatchObject({ kind: 'fail', truncated: true });
    expect(failuresOf(result)).toHaveLength(maximumFailures);

    expect(result).toMatchObject({
      tests: titles.map((title) => ({
        file: testFilePath,
        fullname: `suite ${title}`,
        status: 'failed',
        durationMs: 3,
      })),
    });
  });
});

describe('failure messages', () => {
  it.each<MessageCase>([
    {
      name: 'keeps the headline and the worktree frame',
      failureMessages: ['AssertionError: boom\n    at /repo/src/a.ts:12:4'],
      expected: 'AssertionError: boom (src/a.ts:12)',
    },
    {
      name: 'reads a frame in parentheses with a file URL',
      failureMessages: ['boom\n    at fn (file:///repo/src/a.ts:7:1)'],
      expected: 'boom (src/a.ts:7)',
    },
    {
      name: 'drops a frame outside the worktree',
      failureMessages: ['boom\n    at /other/x.ts:1:1'],
      expected: 'boom',
    },
    {
      name: 'drops a frame inside node_modules',
      failureMessages: ['boom\n    at /repo/node_modules/x/index.js:3:2'],
      expected: 'boom',
    },
    {
      name: 'ignores a location line without the "at " prefix',
      failureMessages: ['boom\n/repo/src/a.ts:4:1'],
      expected: 'boom',
    },
    {
      name: 'uses only the frame when the headline is STACK_TRACE_ERROR',
      failureMessages: ['STACK_TRACE_ERROR\n    at /repo/src/a.ts:9:2'],
      expected: 'src/a.ts:9',
    },
    {
      name: 'keeps a headline with no frame',
      failureMessages: ['boom'],
      expected: 'boom',
    },
    {
      name: 'reads a trailing separator on the worktree path',
      failureMessages: ['boom\n    at /repo/src/a.ts:2:1'],
      cwd: '/repo/',
      expected: 'boom (src/a.ts:2)',
    },
    {
      name: 'caps a long headline at 300 characters',
      failureMessages: ['x'.repeat(400)],
      expected: `${'x'.repeat(300)}…`,
    },
    {
      name: 'keeps a multi-byte character whole when it ends the cap',
      failureMessages: [`a${'é'.repeat(300)}`],
      expected: `a${'é'.repeat(299)}…`,
    },
    {
      name: 'drops an emoji that crosses the 300-unit cap',
      failureMessages: [`${'a'.repeat(299)}😀`],
      expected: `${'a'.repeat(299)}…`,
    },
    {
      name: 'keeps a headline with a worktree path ahead of the stack frame',
      failureMessages: [
        'Error: cannot read /repo/src/config.ts:12:5\n    at /repo/src/a.test.ts:42:15',
      ],
      expected: 'Error: cannot read /repo/src/config.ts:12:5 (src/a.test.ts:42)',
    },
    {
      name: 'drops a frame under a sibling path that shares the worktree prefix',
      failureMessages: [
        'Error: STACK_TRACE_ERROR\n    at Object.handler (/repo-sibling/src/a.test.ts:3:15)',
      ],
      expected: '',
    },
  ])('$name', ({ failureMessages, cwd, expected }) => {
    expect(messageOf(failureMessages, cwd)).toBe(expected);
  });
});

describe('unparseableReportResult', () => {
  it.each<UnparseableCase>([
    {
      name: 'compile-error on a nonzero exit',
      exitCode: 1,
      stdout: 'output',
      stderr: '',
      expected: {
        kind: 'compile-error',
        message: 'no parseable report from vitest',
        tests: [],
      },
    },
    {
      name: 'fail with stderr when the exit is zero',
      exitCode: 0,
      stdout: 'output',
      stderr: 'boom',
      expected: {
        kind: 'fail',
        failures: [
          {
            file: '<runner>',
            fullname: '<parse>',
            message: 'unparseable vitest output: boom',
          },
        ],
        tests: [],
        truncated: false,
      },
    },
    {
      name: 'fail with stdout when stderr is empty',
      exitCode: 0,
      stdout: 'output',
      stderr: '',
      expected: {
        kind: 'fail',
        failures: [
          {
            file: '<runner>',
            fullname: '<parse>',
            message: 'unparseable vitest output: output',
          },
        ],
        tests: [],
        truncated: false,
      },
    },
    {
      name: 'fail with the first line of multi-line output',
      exitCode: 0,
      stdout: '',
      stderr: 'first line\nsecond line',
      expected: {
        kind: 'fail',
        failures: [
          {
            file: '<runner>',
            fullname: '<parse>',
            message: 'unparseable vitest output: first line',
          },
        ],
        tests: [],
        truncated: false,
      },
    },
  ])('returns $name', ({ exitCode, stdout, stderr, expected }) => {
    expect(unparseableReportResult(fullRun(), exitCode, stdout, stderr)).toEqual(expected);
  });
});
