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

export type SpawnFn = (
  command: string,
  arguments_: string[],
  options: SpawnOptions,
) => Promise<SpawnResult>;

export type ResolveVitestFn = (cwd: string) => string | null;

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
