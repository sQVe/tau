import type { VitestAssertionResult, VitestReport, VitestTestFile } from '../runner/report.js';
import type { RunTestsInput } from '../runner/types.js';

export const worktree = '/repo';
export const testFilePath = '/repo/a.test.ts';

export const focusedRun = (testNames: string[], cwd = worktree): RunTestsInput => ({
  scope: 'focused',
  cwd,
  verificationArgv: ['node', 'vitest', 'run'],
  files: ['a.test.ts'],
  testNames,
});

export const fullRun = (cwd = worktree): RunTestsInput => ({
  scope: 'full',
  cwd,
  verificationArgv: ['node', 'vitest', 'run'],
});

export const assertion = (
  overrides: Partial<VitestAssertionResult> = {},
): VitestAssertionResult => ({
  status: 'passed',
  title: 'works',
  ancestorTitles: ['suite'],
  duration: 3,
  ...overrides,
});

export const testFile = (
  assertionResults: VitestAssertionResult[],
  overrides: Partial<VitestTestFile> = {},
): VitestTestFile => ({
  name: testFilePath,
  status: assertionResults.some((entry) => entry.status === 'failed') ? 'failed' : 'passed',
  assertionResults,
  ...overrides,
});

export const reportOf = (testResults: VitestTestFile[]): VitestReport => {
  const assertions = testResults.flatMap((file) => file.assertionResults);

  return {
    numTotalTests: assertions.length,
    numFailedTests: assertions.filter((entry) => entry.status === 'failed').length,
    numPassedTests: assertions.filter((entry) => entry.status === 'passed').length,
    testResults,
  };
};

export const validReport = reportOf([testFile([assertion()])]);

export const rawReport = (assertionResult: unknown): string =>
  JSON.stringify({
    numTotalTests: 1,
    numFailedTests: 0,
    numPassedTests: 1,
    testResults: [{ name: testFilePath, status: 'passed', assertionResults: [assertionResult] }],
  });
