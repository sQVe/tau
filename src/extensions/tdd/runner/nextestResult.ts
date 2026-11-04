import { capMessage, maximumFailures } from './constants.js';
import type { JunitReport } from './junit.js';
import type { RunnerResult, TestResult } from './types.js';

interface StageFacts {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

export interface ListFacts extends StageFacts {
  stderr: string;
}

export interface RunFacts extends StageFacts {
  report: JunitReport | null;
  reportPath: string;
}

const buildFailedExitCode = 101;
const testsFailedExitCode = 100;
const noTestsExitCode = 4;
const maximumBuildExcerptLength = 1000;

const compileError = (message: string, tests: TestResult[] = []): RunnerResult => ({
  kind: 'compile-error',
  message,
  tests,
});

const exitText = (code: number | null) => String(code ?? 'unavailable');

const buildExcerpt = (stderr: string): string => {
  const firstError = stderr.search(/^error/m);
  const relevant = firstError === -1 ? stderr : stderr.slice(firstError);

  return relevant.trim().slice(0, maximumBuildExcerptLength);
};

const interruption = (facts: StageFacts, stage: string): RunnerResult | undefined => {
  if (facts.aborted) {
    return { kind: 'cancelled' };
  }

  return facts.timedOut ? { kind: 'timeout', stage } : undefined;
};

export const listOutcome = (facts: ListFacts): RunnerResult | undefined => {
  const interrupted = interruption(facts, 'list');

  if (interrupted !== undefined) {
    return interrupted;
  }

  if (facts.code === 0) {
    return undefined;
  }

  if (facts.code === buildFailedExitCode) {
    return compileError(
      `cargo nextest list could not build the tests:\n${buildExcerpt(facts.stderr)}`,
    );
  }

  return compileError(`cargo nextest list exited with code ${exitText(facts.code)}.`);
};

const testResults = (report: JunitReport): TestResult[] =>
  report.testCases.map((testCase) => ({
    file: '',
    fullname: testCase.name,
    binaryId: testCase.binaryId,
    status: testCase.status,
    durationMs: testCase.durationMs,
  }));

const failResult = (report: JunitReport, tests: TestResult[]): RunnerResult => {
  const failed = report.testCases.filter((testCase) => testCase.status === 'failed');

  return {
    kind: 'fail',
    failures: failed.slice(0, maximumFailures).map((testCase) => ({
      file: '',
      fullname: testCase.name,
      binaryId: testCase.binaryId,
      message: capMessage(testCase.failureText.trim()),
    })),
    tests,
    truncated: failed.length > maximumFailures,
  };
};

const reportOutcome = (code: number | null, report: JunitReport): RunnerResult => {
  if (report.testCases.some((testCase) => testCase.timedOut)) {
    return { kind: 'timeout', stage: 'run' };
  }

  const tests = testResults(report);

  if (code === noTestsExitCode) {
    return { kind: 'no-tests-collected', tests };
  }

  if (code === testsFailedExitCode) {
    return failResult(report, tests);
  }

  if (code !== 0) {
    return compileError(`cargo nextest run exited with code ${exitText(code)}.`, tests);
  }

  if (!tests.some((test) => test.status === 'passed')) {
    return { kind: 'no-tests-collected', tests };
  }

  return { kind: 'pass', tests };
};

export const runOutcome = (facts: RunFacts): RunnerResult => {
  const interrupted = interruption(facts, 'run');

  if (interrupted !== undefined) {
    return interrupted;
  }

  if (facts.report === null) {
    return compileError(
      `cargo nextest run exited with code ${exitText(facts.code)} and left no readable JUnit report at ${facts.reportPath}.`,
    );
  }

  return reportOutcome(facts.code, facts.report);
};
