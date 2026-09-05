export type RunTestsScope = 'changed' | 'file' | 'all';

export interface RunTestsInput {
  scope: RunTestsScope;
  cwd: string;
  path?: string;
  filter?: string;
  files?: string[];
}

export interface TestFailure {
  file: string;
  fullname: string;
  message: string;
}

export type RunnerResult =
  | { kind: 'pass'; total: number }
  | {
      kind: 'fail';
      failures: TestFailure[];
      total: number;
      failed: number;
      truncated: boolean;
    }
  | { kind: 'compile-error'; message: string; stdout: string; stderr: string }
  | { kind: 'no-tests-collected' }
  | { kind: 'timeout' }
  | { kind: 'runner-missing'; message: string };

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface SpawnOptions {
  cwd: string;
  timeoutMs: number;
}

export type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => Promise<SpawnResult>;

export type ResolveVitestFn = (cwd: string) => string | null;

export interface RunnerDeps {
  resolveVitest: ResolveVitestFn;
  spawn: SpawnFn;
  timeoutMs: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_FAILURES = 10;
export const MAX_ASSERTION_BYTES = 2 * 1024;
export const MAX_TOTAL_BYTES = 32 * 1024;
