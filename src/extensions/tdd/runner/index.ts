import type { RunTestsInput, RunnerDeps, RunnerResult } from './types.js';
import { defaultDeps, runVitest } from './vitest.js';

export { runnerAvailable } from './vitest.js';

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
  dependencies: RunnerDeps = defaultDeps(input.scope),
): Promise<RunnerResult> => runVitest(input, dependencies);
