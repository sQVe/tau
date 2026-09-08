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
}

export type RunnerResult =
  | { kind: 'pass'; tests: TestResult[] }
  | {
      kind: 'fail';
      failures: TestFailure[];
      tests: TestResult[];
      truncated: boolean;
    }
  | { kind: 'compile-error'; message: string; stdout: string; stderr: string; tests: TestResult[] }
  | { kind: 'no-tests-collected'; tests: TestResult[] }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'output-limit'; message: string }
  | { kind: 'runner-missing'; message: string };

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  stdoutOverflow?: boolean;
}

export interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => Promise<SpawnResult>;

export type ResolveVitestFn = (cwd: string) => string | null;

export interface RunnerDeps {
  resolveVitest: ResolveVitestFn;
  spawn: SpawnFn;
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const FULL_TIMEOUT_MS = 120_000;
export const MAX_FAILURES = 10;
export const MAX_ASSERTION_BYTES = 2 * 1024;
export const MAX_MESSAGE_CHARS = 300;
export const MAX_TOTAL_BYTES = 32 * 1024;
// The JSON report must stay complete, so stdout gets a far larger cap than the
// diagnostic one: enough for a full-suite report, small enough to bound memory.
export const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
