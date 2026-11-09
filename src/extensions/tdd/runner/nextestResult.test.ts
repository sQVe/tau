import { describe, expect, it } from 'vitest';

import type { JunitReport } from './junit.js';
import { listOutcome, runOutcome } from './nextestResult.js';
import type { ListFacts, RunFacts } from './nextestResult.js';
import type { TestResult } from './types.js';

const testCase = (
  name: string,
  status: 'passed' | 'failed' | 'skipped',
  overrides: { timedOut?: boolean; failureText?: string } = {},
) => ({
  name,
  binaryId: 'demo',
  status,
  timedOut: false,
  failureText: '',
  durationMs: 1,
  ...overrides,
});

const passed: JunitReport = { testCases: [testCase('tests::adds', 'passed')] };

const failed: JunitReport = {
  testCases: [
    testCase('tests::adds', 'passed'),
    testCase('tests::fails', 'failed', { failureText: '  boom\n' }),
  ],
};

const timedOut: JunitReport = {
  testCases: [testCase('tests::sleeps', 'failed', { timedOut: true })],
};

const skipped: JunitReport = { testCases: [testCase('tests::later', 'skipped')] };

const stage = {
  code: 0,
  timedOut: false,
  aborted: false,
  binaries: [],
  requestedFiles: [],
};

const unknown = { kind: 'unknown' as const, reason: 'no binary named demo' };

describe('listOutcome', () => {
  it.for<{ name: string; facts: ListFacts; outcome: ReturnType<typeof listOutcome> }>([
    { name: 'exit 0 continues to run', facts: { ...stage, stderr: '' }, outcome: undefined },
    {
      name: 'an abort wins over a timeout and a build failure',
      facts: { code: 101, timedOut: true, aborted: true, stderr: 'error' },
      outcome: { kind: 'cancelled' },
    },
    {
      name: 'a timeout wins over a build failure',
      facts: { ...stage, code: 101, timedOut: true, stderr: 'error' },
      outcome: { kind: 'timeout', stage: 'list' },
    },
    {
      name: 'exit 101 quotes stderr from the first error line',
      facts: {
        ...stage,
        code: 101,
        stderr: '   Compiling demo\nerror[E0425]: x\n  --> src/lib.rs\n',
      },
      outcome: {
        kind: 'compile-error',
        message: 'cargo nextest list could not build the tests:\nerror[E0425]: x\n  --> src/lib.rs',
        tests: [],
      },
    },
    {
      name: 'exit 101 without an error line quotes all of stderr',
      facts: { ...stage, code: 101, stderr: '  linker failed  ' },
      outcome: {
        kind: 'compile-error',
        message: 'cargo nextest list could not build the tests:\nlinker failed',
        tests: [],
      },
    },
    {
      name: 'another exit names its code',
      facts: { ...stage, code: 2, stderr: '' },
      outcome: {
        kind: 'compile-error',
        message: 'cargo nextest list exited with code 2.',
        tests: [],
      },
    },
    {
      name: 'another exit quotes stderr',
      facts: {
        ...stage,
        code: 102,
        stderr: 'info: probing\nerror: cannot update the lock file because --locked was passed\n',
      },
      outcome: {
        kind: 'compile-error',
        message:
          'cargo nextest list exited with code 102:\nerror: cannot update the lock file because --locked was passed',
        tests: [],
      },
    },
    {
      name: 'a missing exit code is named unavailable',
      facts: { ...stage, code: null, stderr: '' },
      outcome: {
        kind: 'compile-error',
        message: 'cargo nextest list exited with code unavailable.',
        tests: [],
      },
    },
  ])('$name', ({ facts, outcome }) => {
    expect(listOutcome(facts)).toEqual(outcome);
  });
});

const passedTests: TestResult[] = [
  {
    file: '',
    fullname: 'tests::adds',
    binaryId: 'demo',
    status: 'passed',
    durationMs: 1,
    attribution: unknown,
  },
];

const failedTests: TestResult[] = [
  ...passedTests,
  {
    file: '',
    fullname: 'tests::fails',
    binaryId: 'demo',
    status: 'failed',
    durationMs: 1,
    attribution: unknown,
  },
];

const reportPath = '/diagnostics/report.xml';

describe('runOutcome', () => {
  it.for<{ name: string; facts: RunFacts; outcome: ReturnType<typeof runOutcome> }>([
    {
      name: 'an abort wins over a missing report',
      facts: { ...stage, aborted: true, timedOut: true, report: null, reportPath },
      outcome: { kind: 'cancelled' },
    },
    {
      name: 'a process timeout wins over the report',
      facts: { ...stage, timedOut: true, report: passed, reportPath },
      outcome: { kind: 'timeout', stage: 'run' },
    },
    {
      name: 'a missing report is an error, not a pass',
      facts: { ...stage, report: null, reportPath },
      outcome: {
        kind: 'compile-error',
        message: `cargo nextest run exited with code 0 and left no readable JUnit report at ${reportPath}.`,
        tests: [],
      },
    },
    {
      name: 'a timed-out test makes the run a timeout',
      facts: { ...stage, code: 100, report: timedOut, reportPath },
      outcome: { kind: 'timeout', stage: 'run' },
    },
    {
      name: 'exit 4 collects no tests',
      facts: { ...stage, code: 4, report: { testCases: [] }, reportPath },
      outcome: { kind: 'no-tests-collected', tests: [] },
    },
    {
      name: 'exit 100 fails with the trimmed failure text',
      facts: { ...stage, code: 100, report: failed, reportPath },
      outcome: {
        kind: 'fail',
        failures: [
          {
            file: '',
            fullname: 'tests::fails',
            binaryId: 'demo',
            message: 'boom',
            attribution: unknown,
          },
        ],
        tests: failedTests,
        truncated: false,
      },
    },
    {
      name: 'another exit names its code and keeps the tests',
      facts: { ...stage, code: 3, report: passed, reportPath },
      outcome: {
        kind: 'compile-error',
        message: 'cargo nextest run exited with code 3.',
        tests: passedTests,
      },
    },
    {
      name: 'exit 0 with only skipped tests collects no tests',
      facts: { ...stage, report: skipped, reportPath },
      outcome: {
        kind: 'no-tests-collected',
        tests: [
          {
            file: '',
            fullname: 'tests::later',
            binaryId: 'demo',
            status: 'skipped',
            durationMs: 1,
            attribution: unknown,
          },
        ],
      },
    },
    {
      name: 'exit 0 with a passed test passes',
      facts: { ...stage, report: passed, reportPath },
      outcome: { kind: 'pass', tests: passedTests },
    },
  ])('$name', ({ facts, outcome }) => {
    expect(runOutcome(facts)).toEqual(outcome);
  });

  it.for([
    { count: 10, truncated: false },
    { count: 11, truncated: true },
  ])('keeps at most 10 of $count failures', ({ count, truncated }) => {
    const report: JunitReport = {
      testCases: Array.from({ length: count }, (_, index) =>
        testCase(`tests::fails_${index}`, 'failed'),
      ),
    };

    const outcome = runOutcome({ ...stage, code: 100, report, reportPath });

    expect(outcome).toMatchObject({ kind: 'fail', truncated });
    expect('failures' in outcome && outcome.failures).toHaveLength(10);
  });
});
