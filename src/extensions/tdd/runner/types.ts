import type { TddConfig } from '../config.js';

export type RunTestsInput =
  | {
      scope: 'focused';
      cwd: string;
      verificationArgv: readonly string[];
      files: string[];
      testNames: string[];
      signal?: AbortSignal | undefined;
    }
  | {
      scope: 'full';
      cwd: string;
      verificationArgv: readonly string[];
      signal?: AbortSignal | undefined;
    };

export type TestAttribution =
  | { kind: 'ambiguous'; binaryIds: string[]; files?: string[] }
  | { kind: 'unknown'; reason: string };

export interface TestFailure {
  file: string;
  fullname: string;
  message: string;
  binaryId?: string;
  attribution?: TestAttribution;
}

export interface TestResult {
  file: string;
  fullname: string;
  binaryId?: string;
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  durationMs?: number;
  attribution?: TestAttribution;
}

export interface DiagnosticFile {
  path: string;
  bytes: number;
  decodedBytes?: number;
  savedBytes: number;
  truncated: boolean;
}

export type ReportFormat = 'json' | 'junit';

export interface ReportTarget {
  path: string;
  format: ReportFormat;
}

interface ReportEntry extends ReportTarget {
  file?: DiagnosticFile | undefined;
}

export interface RunStage {
  name: string;
  command: string[];
  started: boolean;
  exitCode: number | null;
  durationMs: number;
  stdout?: DiagnosticFile | undefined;
  stderr?: DiagnosticFile | undefined;
  excerpt?: string;
}

export interface PackageResolutionDiagnostic {
  cwd: string;
  request: 'vitest/package.json';
  stage: 'lookup' | 'manifest' | 'binary' | 'resolver';
  manifestPath?: string;
  binaryPath?: string;
  errorCode?: string;
  errorType: string;
}

export interface ExecutableResolutionDiagnostic {
  executable: string;
  searchedPath: string;
}

export type ResolutionDiagnostic = PackageResolutionDiagnostic | ExecutableResolutionDiagnostic;

export interface RunnerResolutionFailure {
  kind: 'runner-missing' | 'runner-resolution-error';
  message: string;
  resolution: ResolutionDiagnostic;
}

export interface RunDiagnostics {
  directory: string;
  durationMs: number;
  timeoutMs: number;
  report: ReportEntry;
  stages: RunStage[];
  error?: string;
  resolution?: ResolutionDiagnostic;
}

export type RunnerResult = { diagnostics?: RunDiagnostics } & (
  | { kind: 'pass'; tests: TestResult[] }
  | {
      kind: 'fail';
      failures: TestFailure[];
      tests: TestResult[];
      truncated: boolean;
    }
  | { kind: 'compile-error'; message: string; tests: TestResult[] }
  | { kind: 'no-tests-collected'; tests: TestResult[]; message?: string }
  | { kind: 'timeout'; stage?: string }
  | { kind: 'cancelled' }
  | RunnerResolutionFailure
);

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  command: string[];
  started: boolean;
  stdoutTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  stdoutFile?: string | undefined;
}

export type SpawnCommand = (
  executable: string,
  argumentsList: string[],
  options: SpawnOptions,
) => Promise<SpawnResult>;

export interface TestRunner {
  name: string;
  defaults: TddConfig;
  configurationGlobs: string[];
  testNameFormat: string;
  focusedTimeoutMs: number;
  fullTimeoutMs: number;
  /**
   * When true, a file that matches both the test and production globs is a production file too.
   * An edit to it counts as a production edit even when only its tests changed, so the freshness
   * hint can come early.
   */
  testFilesCanBeProduction: boolean;
  verificationArgvError: (verificationArgv: readonly string[]) => string | null;
  run: (input: RunTestsInput) => Promise<RunnerResult>;
}
