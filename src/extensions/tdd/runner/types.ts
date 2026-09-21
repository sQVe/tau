export type RunTestsScope = 'changed' | 'file' | 'all';

export interface RunTestsInput {
  scope: RunTestsScope;
  cwd: string;
  path?: string;
  filter?: string;
  files?: string[];
  signal?: AbortSignal | undefined;
}

export interface TestFailure {
  file: string;
  fullname: string;
  message: string;
}

export interface TestResult {
  file: string;
  fullname: string;
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  durationMs?: number;
}

export interface DiagnosticFile {
  path: string;
  bytes: number;
  decodedBytes?: number;
  savedBytes: number;
  truncated: boolean;
}

export interface VitestResolutionDiagnostic {
  cwd: string;
  request: 'vitest/package.json';
  stage: 'lookup' | 'manifest' | 'binary' | 'resolver';
  manifestPath?: string;
  binaryPath?: string;
  errorCode?: string;
  errorType: string;
}

export interface VitestResolutionFailure {
  kind: 'runner-missing' | 'runner-resolution-error';
  message: string;
  resolution: VitestResolutionDiagnostic;
}

export interface RunDiagnostics {
  directory: string;
  durationMs: number;
  timeoutMs: number;
  started?: boolean;
  command?: string[] | undefined;
  exitCode: number | null;
  stdout?: DiagnosticFile | undefined;
  stderr?: DiagnosticFile | undefined;
  report?: DiagnosticFile | undefined;
  excerpt?: string;
  error?: string;
  resolution?: VitestResolutionDiagnostic;
}

export type RunnerResult = { diagnostics?: RunDiagnostics } & (
  | { kind: 'pass'; tests: TestResult[] }
  | {
      kind: 'fail';
      failures: TestFailure[];
      tests: TestResult[];
      truncated: boolean;
    }
  | { kind: 'compile-error'; message: string; stdout: string; stderr: string; tests: TestResult[] }
  | { kind: 'no-tests-collected'; tests: TestResult[]; message?: string }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | VitestResolutionFailure
);

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  command?: string[];
  started?: boolean;
  stdoutTruncated?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
}

export interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type SpawnFn = (
  command: string,
  argumentsList: string[],
  options: SpawnOptions,
) => Promise<SpawnResult>;

export interface ResolvedVitest {
  path: string;
  version: string;
}

export type ResolveVitestFn = (cwd: string) => ResolvedVitest | VitestResolutionFailure;

export interface RunnerDeps {
  resolveVitest: ResolveVitestFn;
  spawn: SpawnFn;
  timeoutMs: number;
}

export const defaultTimeoutMilliseconds = 30_000;
export const fullTimeoutMilliseconds = 120_000;
export const maximumFailures = 10;
export const maximumMessageCharacters = 300;
export const maximumTotalBytes = 32 * 1024;

// Bound captured process output separately from the shorter diagnostic messages.
export const maximumStdoutBytes = 8 * 1024 * 1024;
export const maximumReportBytes = 8 * 1024 * 1024;
