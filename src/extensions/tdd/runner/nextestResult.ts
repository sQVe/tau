import { capMessage, maximumFailures } from './constants.js';
import type { JunitReport } from './junit.js';
import { attributeRustResult } from './rustAttribution.js';
import type { RustBinarySources } from './rustAttribution.js';
import type { RunnerResult, TestAttribution, TestFailure, TestResult } from './types.js';

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
  binaries: RustBinarySources[];
  requestedFiles: string[];
}

interface ResultFields {
  file: string;
  attribution?: TestAttribution;
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

export const metadataOutcome = (facts: ListFacts): RunnerResult | undefined => {
  const interrupted = interruption(facts, 'metadata');

  if (interrupted !== undefined) {
    return interrupted;
  }

  if (facts.code === 0) {
    return undefined;
  }

  return compileError(
    `cargo metadata exited with code ${exitText(facts.code)}:\n${buildExcerpt(facts.stderr)}`,
  );
};

const resultFields = (
  facts: RunFacts,
  testCase: JunitReport['testCases'][number],
): ResultFields => {
  const attribution = attributeRustResult({
    result: { binaryId: testCase.binaryId, fullname: testCase.name },
    binaries: facts.binaries,
    requestedFiles: facts.requestedFiles,
  });

  if (attribution.kind === 'exact') {
    return { file: attribution.file };
  }

  return { file: '', attribution };
};

const testResult = (facts: RunFacts, testCase: JunitReport['testCases'][number]): TestResult => {
  const fields = resultFields(facts, testCase);

  const result: TestResult = {
    file: fields.file,
    fullname: testCase.name,
    binaryId: testCase.binaryId,
    status: testCase.status,
    durationMs: testCase.durationMs,
  };

  if (fields.attribution !== undefined) {
    result.attribution = fields.attribution;
  }

  return result;
};

const testResults = (facts: RunFacts, report: JunitReport): TestResult[] =>
  report.testCases.map((testCase) => testResult(facts, testCase));

const failure = (facts: RunFacts, testCase: JunitReport['testCases'][number]): TestFailure => {
  const fields = resultFields(facts, testCase);

  const entry: TestFailure = {
    file: fields.file,
    fullname: testCase.name,
    binaryId: testCase.binaryId,
    message: capMessage(testCase.failureText.trim()),
  };

  if (fields.attribution !== undefined) {
    entry.attribution = fields.attribution;
  }

  return entry;
};

const failResult = (facts: RunFacts, report: JunitReport, tests: TestResult[]): RunnerResult => {
  const failed = report.testCases.filter((testCase) => testCase.status === 'failed');

  return {
    kind: 'fail',
    failures: failed.slice(0, maximumFailures).map((testCase) => failure(facts, testCase)),
    tests,
    truncated: failed.length > maximumFailures,
  };
};

const reportOutcome = (facts: RunFacts, report: JunitReport): RunnerResult => {
  if (report.testCases.some((testCase) => testCase.timedOut)) {
    return { kind: 'timeout', stage: 'run' };
  }

  const tests = testResults(facts, report);

  if (facts.code === noTestsExitCode) {
    return { kind: 'no-tests-collected', tests };
  }

  if (facts.code === testsFailedExitCode) {
    return failResult(facts, report, tests);
  }

  if (facts.code !== 0) {
    return compileError(`cargo nextest run exited with code ${exitText(facts.code)}.`, tests);
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

  return reportOutcome(facts, facts.report);
};
