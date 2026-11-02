import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { saveDiagnostics } from './diagnostics.js';
import { defaultSpawn } from './process.js';
import { classifyReport, parseReport, unparseableReportResult } from './report.js';
import type { VitestReport } from './report.js';
import { defaultResolveVitest, explainSessionCwd, resolutionFailure } from './resolution.js';
import { createDiagnosticsDirectory } from './retention.js';
import type {
  ResolveVitest,
  RunTestsInput,
  RunnerDeps,
  RunnerResult,
  SpawnResult,
} from './types.js';

const defaultTimeoutMilliseconds = 30_000;
const fullTimeoutMilliseconds = 120_000;

// The report is read from the reporter's own output file: stdout carries test-controlled
// text, so a report scraped from it could be forged by the code under test.
const readReport = async (path: string): Promise<VitestReport | null> => {
  try {
    return parseReport(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

// Vitest's CLI parses dash-leading positionals as options and treats an empty
// filter as "match every file", so neither may reach it as a scoped path.
const toFilterArgument = (path: string) => (path.startsWith('-') ? `./${path}` : path);

const scopedPaths = (input: RunTestsInput): string[] => {
  const paths = input.scope === 'focused' ? input.files : [];

  return paths.filter((path) => path.trim().length > 0);
};

const exactNamePattern = (testNames: readonly string[]) =>
  `^(?:${testNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;

const buildArguments = (input: RunTestsInput, outputFile: string): string[] | null => {
  const runnerArguments: string[] = [
    ...input.verificationArgv.slice(1),
    `--outputFile=${outputFile}`,
  ];

  if (input.scope === 'focused') {
    const paths = scopedPaths(input);

    if (paths.length === 0) {
      return null;
    }

    runnerArguments.push(...paths.map(toFilterArgument));
    runnerArguments.push('-t', exactNamePattern(input.testNames));
  }

  return runnerArguments;
};

export const defaultDeps = (scope: RunTestsInput['scope'] = 'focused'): RunnerDeps => ({
  resolveVitest: defaultResolveVitest,
  spawn: defaultSpawn,
  timeoutMs: scope === 'full' ? fullTimeoutMilliseconds : defaultTimeoutMilliseconds,
});

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
    return unparseableReportResult(input, result.code, result.stdout, result.stderr);
  }

  return classifyReport(input, result.code, report, version);
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

  let runner: ReturnType<ResolveVitest>;

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
        started: result?.started ?? false,
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
