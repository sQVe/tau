import { isAbsolute, relative } from 'node:path';

import { isRecord } from '../../../schema.js';
import type { RunnerResult, RunTestsInput, TestFailure, TestResult } from './types.js';

type VitestAssertionStatus = TestResult['status'] | 'pending' | 'disabled';

export interface VitestAssertionResult {
  fullName?: string;
  title?: string;
  ancestorTitles?: string[];
  status: VitestAssertionStatus;
  failureMessages?: string[];
  duration?: number | null;
}

export interface VitestTestFile {
  name?: string;
  status?: string;
  assertionResults: VitestAssertionResult[];
  message?: string;
}

export interface VitestReport {
  numTotalTests: number;
  numFailedTests: number;
  numPassedTests: number;
  numTotalTestSuites?: number;
  startTime?: number;
  success?: boolean;
  testResults: VitestTestFile[];
}

export const maximumFailures = 10;
const maximumMessageCharacters = 300;

const assertionStatuses = new Set<string>([
  'passed',
  'failed',
  'skipped',
  'todo',
  'pending',
  'disabled',
]);

const fileStatuses = new Set<string>(['passed', 'failed']);

const isOptionalString = (value: unknown) => value === undefined || typeof value === 'string';

const isStringArray = (value: unknown) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isOptionalStringArray = (value: unknown) => value === undefined || isStringArray(value);

const isOptionalNumberOrNull = (value: unknown) =>
  value === undefined || value === null || typeof value === 'number';

const isReportCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isVitestAssertionResult = (value: unknown): value is VitestAssertionResult => {
  if (!isRecord(value)) {
    return false;
  }

  if (!isOptionalString(value.fullName)) {
    return false;
  }

  if (!isOptionalString(value.title)) {
    return false;
  }

  if (!isOptionalStringArray(value.ancestorTitles)) {
    return false;
  }

  if (!isOptionalStringArray(value.failureMessages)) {
    return false;
  }

  if (!isOptionalNumberOrNull(value.duration)) {
    return false;
  }

  if (typeof value.status !== 'string') {
    return false;
  }

  return assertionStatuses.has(value.status);
};

const isVitestTestFile = (value: unknown): value is VitestTestFile => {
  if (!isRecord(value)) {
    return false;
  }

  if (!isOptionalString(value.name)) {
    return false;
  }

  if (!isOptionalString(value.message)) {
    return false;
  }

  if (typeof value.status !== 'string') {
    return false;
  }

  if (!fileStatuses.has(value.status)) {
    return false;
  }

  if (!Array.isArray(value.assertionResults)) {
    return false;
  }

  return value.assertionResults.every(isVitestAssertionResult);
};

const isVitestReport = (value: unknown): value is VitestReport => {
  if (!isRecord(value)) {
    return false;
  }

  if (!isReportCount(value.numTotalTests)) {
    return false;
  }

  if (!isReportCount(value.numFailedTests)) {
    return false;
  }

  if (!isReportCount(value.numPassedTests)) {
    return false;
  }

  if (!Array.isArray(value.testResults)) {
    return false;
  }

  return value.testResults.every(isVitestTestFile);
};

// Malformed JSON and any shape the validators reject both mean no report.
export const parseReport = (text: string): VitestReport | null => {
  try {
    const parsed: unknown = JSON.parse(text);

    return isVitestReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

// Vitest 5 joins nested test names with ` > `; earlier versions use a space.
const arrowSeparatorMajor = 5;
const maximumCandidates = 5;

const nameSeparator = (version: string) =>
  Number.parseInt(version, 10) >= arrowSeparatorMajor ? ' > ' : ' ';

export const assertionFullName = (assertion: VitestAssertionResult, version: string): string => {
  // Vitest 5 filters with " > " but its Jest-compatible JSON fullName still uses spaces.
  // Rebuild from title parts; replacing spaces would change literal names and merge identities.
  if (
    nameSeparator(version) === ' > ' &&
    assertion.ancestorTitles !== undefined &&
    assertion.title !== undefined
  ) {
    return [...assertion.ancestorTitles, assertion.title].join(' > ');
  }

  return (
    assertion.fullName ??
    [...(assertion.ancestorTitles ?? []), assertion.title ?? ''].filter(Boolean).join(' ')
  );
};

// A focused run reports every unselected test as skipped, which says nothing about it.
const selects = (testNames: readonly string[] | undefined) => {
  if (testNames === undefined) {
    return () => true;
  }

  return (fullname: string) => testNames.includes(fullname);
};

const toTestResult = (
  file: VitestTestFile,
  assertion: VitestAssertionResult,
  version: string,
): TestResult => {
  const result: TestResult = {
    file: file.name ?? '<unknown>',
    fullname: assertionFullName(assertion, version),
    status:
      assertion.status === 'pending' || assertion.status === 'disabled'
        ? 'skipped'
        : assertion.status,
  };

  if (typeof assertion.duration === 'number') {
    result.durationMs = Math.round(assertion.duration);
  }

  return result;
};

const collectTests = (
  report: VitestReport,
  selected: (fullname: string) => boolean,
  version: string,
): TestResult[] =>
  report.testResults.flatMap((file) =>
    file.assertionResults
      .filter((assertion) => selected(assertionFullName(assertion, version)))
      .map((assertion) => toTestResult(file, assertion, version)),
  );

const frameLocation = (line: string, cwd: string): string | null => {
  const trimmed = line.trim();

  if (!trimmed.startsWith('at ')) {
    return null;
  }

  const match = /\(?([^()\s]+):(\d+):\d+\)?$/.exec(trimmed);
  const path = match?.[1]?.replace(/^file:\/\//, '');

  if (path == null || path.includes('node_modules') || !isAbsolute(path)) {
    return null;
  }

  const location = relative(cwd, path);

  if (location.length === 0 || location.startsWith('..') || isAbsolute(location)) {
    return null;
  }

  return `${location}:${match?.[2]}`;
};

// Drops a high surrogate left at the cut so an emoji is never split.
const capMessage = (text: string) =>
  text.length > maximumMessageCharacters
    ? `${text.slice(0, maximumMessageCharacters).replace(/[\uD800-\uDBFF]$/, '')}…`
    : text;

// Keep the assertion and its worktree location. Omit the rest of the stack to limit output.
const assertionMessage = (messages: string[], cwd: string): string => {
  const raw = messages[0] ?? '';

  const frame = raw
    .split('\n')
    .map((line) => frameLocation(line, cwd))
    .find((location) => location != null);

  const headline = raw.split('\n')[0]?.trim() ?? '';

  if (headline.length === 0 || headline.includes('STACK_TRACE_ERROR')) {
    return capMessage(frame ?? '');
  }

  return capMessage(frame == null ? headline : `${headline} (${frame})`);
};

const hasFailedAssertion = (file: VitestTestFile): boolean =>
  file.assertionResults.some((assertion) => assertion.status === 'failed');

const isFileFailure = (file: VitestTestFile, failedAssertion: boolean): boolean => {
  if (file.status !== 'failed') {
    return false;
  }

  return (file.message ?? '').length > 0 || !failedAssertion;
};

const fileFailure = (file: VitestTestFile, cwd: string): TestFailure => ({
  file: file.name ?? '<unknown>',
  fullname: '<file>',
  message:
    assertionMessage([file.message ?? ''], cwd) ||
    'File setup or load failed; inspect the saved runner diagnostics.',
});

const assertionFailure = (
  file: VitestTestFile,
  assertion: VitestAssertionResult,
  cwd: string,
  version: string,
): TestFailure => ({
  file: file.name ?? '<unknown>',
  fullname: assertionFullName(assertion, version),
  message: assertionMessage(assertion.failureMessages ?? [], cwd),
});

const collectFileFailures = (
  file: VitestTestFile,
  cwd: string,
  version: string,
  remaining: number,
): { failures: TestFailure[]; truncated: boolean } => {
  const failures: TestFailure[] = [];
  // Hook and load errors live only on the file entry, never on an assertion.
  const failedAssertion = hasFailedAssertion(file);
  let budget = remaining;

  if (isFileFailure(file, failedAssertion)) {
    if (budget <= 0) {
      return { failures, truncated: true };
    }

    failures.push(fileFailure(file, cwd));
    budget -= 1;
  }

  for (const assertion of file.assertionResults) {
    if (assertion.status !== 'failed') {
      continue;
    }

    if (budget <= 0) {
      return { failures, truncated: true };
    }

    failures.push(assertionFailure(file, assertion, cwd, version));
    budget -= 1;
  }

  return { failures, truncated: false };
};

// File errors and assertion failures share one truncation budget.
const collectFailures = (
  report: VitestReport,
  cwd: string,
  version: string,
): { failures: TestFailure[]; truncated: boolean } => {
  const failures: TestFailure[] = [];

  for (const file of report.testResults) {
    const collected = collectFileFailures(file, cwd, version, maximumFailures - failures.length);

    failures.push(...collected.failures);

    if (collected.truncated) {
      return { failures, truncated: true };
    }
  }

  return { failures, truncated: false };
};

const compileErrorResult = (tests: TestResult[], message: string): RunnerResult => ({
  kind: 'compile-error',
  message,
  tests,
});

export const unparseableReportResult = (
  input: RunTestsInput,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): RunnerResult => {
  if (exitCode !== 0) {
    return compileErrorResult([], 'no parseable report from vitest');
  }

  const output = stderr.length > 0 ? stderr : stdout;

  return {
    kind: 'fail',
    failures: [
      {
        file: '<runner>',
        fullname: '<parse>',
        message: assertionMessage([`unparseable vitest output: ${output}`], input.cwd),
      },
    ],
    tests: [],
    truncated: false,
  };
};

const noFilterMatchResult = (
  input: RunTestsInput,
  report: VitestReport,
  tests: TestResult[],
  version: string,
): RunnerResult => {
  const candidates = collectTests(report, () => true, version)
    .slice(0, maximumCandidates)
    .map((test) => `${relative(input.cwd, test.file)}: ${capMessage(test.fullname)}`);

  const message = [
    `No tests matched the exact name filter. Vitest ${version} joins nested names with ${JSON.stringify(nameSeparator(version))}.`,
    'Use the complete describe and test names. Do not restructure tests or broaden the filter.',
    candidates.length > 0
      ? `Collected names (up to 5):\n${candidates.join('\n')}`
      : 'No names were reported; check the selected files and runner diagnostics.',
  ].join('\n');

  return { kind: 'no-tests-collected', tests, message };
};

// Process failures and report validity must be classified before accepting test evidence.
export const classifyReport = (
  input: RunTestsInput,
  exitCode: number | null,
  report: VitestReport,
  version: string,
): RunnerResult => {
  const testNames = input.scope === 'focused' ? input.testNames : undefined;
  const tests = collectTests(report, selects(testNames), version);
  const total = report.numTotalTests;
  const failed = report.numFailedTests;
  const files = report.testResults;

  if (failed > 0 || files.some((file) => file.status === 'failed')) {
    const { failures, truncated } = collectFailures(report, input.cwd, version);

    return {
      kind: 'fail',
      failures,
      tests,
      truncated,
    };
  }

  if (exitCode !== 0) {
    return compileErrorResult(tests, 'vitest did not complete successfully');
  }

  if (input.scope === 'focused' && tests.length === 0) {
    return noFilterMatchResult(input, report, tests, version);
  }

  if (total === 0 || report.numPassedTests === 0) {
    return { kind: 'no-tests-collected', tests };
  }

  return { kind: 'pass', tests };
};
