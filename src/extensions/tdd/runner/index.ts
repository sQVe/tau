import type { RunTestsInput, RunnerDeps, RunnerResult } from './types.js';
import { defaultDeps, runVitest } from './vitest.js';

export type {
  RunTestsInput,
  RunTestsScope,
  RunnerResult,
  TestFailure,
  TestResult,
  RunnerDeps,
} from './types.js';

export const runTests = (
  input: RunTestsInput,
  deps: RunnerDeps = defaultDeps(input.scope),
): Promise<RunnerResult> => runVitest(input, deps);
