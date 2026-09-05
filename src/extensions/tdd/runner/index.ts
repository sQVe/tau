import type { RunTestsInput, RunnerDeps, RunnerResult } from './types.js';
import { defaultDeps, runVitest } from './vitest.js';

export type {
  RunTestsInput,
  RunTestsScope,
  RunnerResult,
  TestFailure,
  RunnerDeps,
} from './types.js';

export const runTests = (
  input: RunTestsInput,
  deps: RunnerDeps = defaultDeps(),
): Promise<RunnerResult> => runVitest(input, deps);
