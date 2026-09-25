import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import { tddConfig } from '../config.js';
import { saveDiagnostics } from './diagnostics.js';
import { defaultSpawn } from './process.js';
import { defaultResolveVitest, explainSessionCwd, resolutionFailure } from './resolution.js';
import { createDiagnosticsDirectory } from './retention.js';
import type {
  ResolveVitestFn,
  RunTestsInput,
  RunnerDeps,
  RunnerResult,
  SpawnResult,
  TestFailure,
  TestResult,
} from './types.js';

interface VitestAssertionResult {
  fullName?: string;
  title?: string;
  ancestorTitles?: string[];
  status: TestResult['status'] | 'pending' | 'disabled';
  failureMessages?: string[];
  duration?: number | null;
}

interface VitestTestFile {
  name?: string;
  status?: string;
  assertionResults?: VitestAssertionResult[];
  message?: string;
}

interface VitestReport {
  numTotalTests?: number;
  numFailedTests?: number;
  numPassedTests?: number;
  numTotalTestSuites?: number;
  startTime?: number;
  success?: boolean;
  testResults?: VitestTestFile[];
}

const defaultTimeoutMilliseconds = 30_000;
const fullTimeoutMilliseconds = 120_000;

export const maximumFailures = 10;
const maximumMessageCharacters = 300;

// Vitest reports always include at least one of these top-level keys.
const isVitestReport = (value: unknown): value is VitestReport => {
  if (value == null || typeof value !== 'object') {
    return false;
  }

  const keys = ['numTotalTests', 'numFailedTests', 'testResults', 'numTotalTestSuites'];

  return keys.some((key) => key in value);
};

// The report is read from the reporter's own output file: stdout carries test-controlled
// text, so a report scraped from it could be forged by the code under test.
const readReport = async (path: string): Promise<VitestReport | null> => {
  try {
    const content = await readFile(path, 'utf8');
    const parsed: unknown = JSON.parse(content);

    return isVitestReport(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const nameSeparator = (version: string) => (Number.parseInt(version, 10) >= 5 ? ' > ' : ' ');

const assertionFullName = (assertion: VitestAssertionResult, version: string): string => {
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

const exactNamePattern = (testNames: readonly string[]) =>
  `^(?:${testNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;

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
  (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? [])
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

const capMessage = (text: string) =>
  text.length > maximumMessageCharacters ? `${text.slice(0, maximumMessageCharacters)}…` : text;

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
  file.assertionResults?.some((assertion) => assertion.status === 'failed') === true;

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

  for (const assertion of file.assertionResults ?? []) {
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

  for (const file of report.testResults ?? []) {
    const collected = collectFileFailures(file, cwd, version, maximumFailures - failures.length);

    failures.push(...collected.failures);

    if (collected.truncated) {
      return { failures, truncated: true };
    }
  }

  return { failures, truncated: false };
};

// Vitest's CLI parses dash-leading positionals as options and treats an empty
// filter as "match every file", so neither may reach it as a scoped path.
const toFilterArgument = (path: string) => (path.startsWith('-') ? `./${path}` : path);

const scopedPaths = (input: RunTestsInput): string[] => {
  const paths = input.scope === 'file' ? [input.path ?? ''] : (input.files ?? []);

  return paths.filter((path) => path.trim().length > 0);
};

const buildArguments = (input: RunTestsInput, outputFile: string): string[] | null => {
  const runnerArguments: string[] = [
    ...tddConfig.verificationArgv.slice(1),
    `--outputFile=${outputFile}`,
  ];

  if (input.scope !== 'all') {
    const paths = scopedPaths(input);

    if (paths.length === 0) {
      return null;
    }

    runnerArguments.push(...paths.map(toFilterArgument));
  }

  if (input.testNames !== undefined) {
    runnerArguments.push('-t', exactNamePattern(input.testNames));
  }

  return runnerArguments;
};

export const defaultDeps = (scope: RunTestsInput['scope'] = 'changed'): RunnerDeps => ({
  resolveVitest: defaultResolveVitest,
  spawn: defaultSpawn,
  timeoutMs: scope === 'all' ? fullTimeoutMilliseconds : defaultTimeoutMilliseconds,
});

const compileErrorResult = (
  result: SpawnResult,
  tests: TestResult[],
  message: string,
): RunnerResult => ({
  kind: 'compile-error',
  message,
  tests,
  stdout: result.stdout,
  stderr: result.stderr,
});

const unparseableReportResult = (input: RunTestsInput, result: SpawnResult): RunnerResult => {
  if (result.code !== 0) {
    return compileErrorResult(result, [], 'no parseable report from vitest');
  }

  const output = result.stderr.length > 0 ? result.stderr : result.stdout;

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
    .slice(0, 5)
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
const classifyReport = (
  input: RunTestsInput,
  result: SpawnResult,
  report: VitestReport,
  version: string,
): RunnerResult => {
  const tests = collectTests(report, selects(input.testNames), version);
  const total = report.numTotalTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const files = report.testResults ?? [];

  if (failed > 0 || files.some((file) => file.status === 'failed')) {
    const { failures, truncated } = collectFailures(report, input.cwd, version);

    return {
      kind: 'fail',
      failures,
      tests,
      truncated,
    };
  }

  if (result.code !== 0) {
    return compileErrorResult(result, tests, 'vitest did not complete successfully');
  }

  if (input.testNames !== undefined && tests.length === 0) {
    return noFilterMatchResult(input, report, tests, version);
  }

  if (total === 0 || report.numPassedTests === 0) {
    return { kind: 'no-tests-collected', tests };
  }

  return { kind: 'pass', tests };
};

const classifyResult = async (
  input: RunTestsInput,
  result: SpawnResult,
  outputFile: string,
  version: string,
): Promise<RunnerResult> => {
  if (input.signal?.aborted === true) {
    return { kind: 'cancelled' };
  }

  if (result.timedOut) {
    return { kind: 'timeout' };
  }

  const report = await readReport(outputFile);

  if (report == null) {
    return unparseableReportResult(input, result);
  }

  return classifyReport(input, result, report, version);
};

const runInDirectory = async (
  input: RunTestsInput,
  dependencies: RunnerDeps,
  outputFile: string,
): Promise<{ report: RunnerResult; result?: SpawnResult }> => {
  const runnerArguments = buildArguments(input, outputFile);

  if (runnerArguments == null) {
    return { report: { kind: 'no-tests-collected', tests: [] } };
  }

  let runner: ReturnType<ResolveVitestFn>;

  try {
    runner = dependencies.resolveVitest(input.cwd);
  } catch (error) {
    runner = resolutionFailure(input.cwd, 'resolver', error);
  }

  if ('kind' in runner) {
    return { report: explainSessionCwd(runner, input.cwd, scopedPaths(input)) };
  }

  const result = await dependencies.spawn(runner.path, runnerArguments, {
    cwd: input.cwd,
    timeoutMs: dependencies.timeoutMs,
    signal: input.signal,
  });

  return { report: await classifyResult(input, result, outputFile, runner.version), result };
};

export const runTests = async (
  input: RunTestsInput,
  dependencies: RunnerDeps = defaultDeps(input.scope),
): Promise<RunnerResult> => {
  const directory = await createDiagnosticsDirectory();
  const started = performance.now();

  try {
    const { report, result } = await runInDirectory(
      input,
      dependencies,
      join(directory, 'report.json'),
    );

    const diagnostics = await saveDiagnostics(
      {
        directory,
        durationMs: Math.round(performance.now() - started),
        timeoutMs: dependencies.timeoutMs,
        command: result?.command,
        started: result?.started ?? result !== undefined,
        exitCode: result?.code ?? null,
        ...('resolution' in report ? { resolution: report.resolution } : {}),
      },
      result,
    );

    return { ...report, diagnostics };
  } catch (error) {
    // Retention prunes a leftover directory once it expires; report the runner error instead.
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);

    throw error;
  }
};
