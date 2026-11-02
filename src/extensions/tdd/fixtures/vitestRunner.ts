import { rm, writeFile } from 'node:fs/promises';

import { onTestFinished } from 'vitest';

import type { RunnerDeps, RunnerResult, SpawnCommand, SpawnResult } from '../runner/types.js';
import { runTests as runTestsWithDiagnostics } from '../runner/vitest.js';

export const runTests = async (
  ...argumentsList: Parameters<typeof runTestsWithDiagnostics>
): Promise<RunnerResult> => {
  const result = await runTestsWithDiagnostics(...argumentsList);

  if (result.diagnostics !== undefined) {
    const directory = result.diagnostics.directory;

    onTestFinished(() => rm(directory, { recursive: true, force: true }));
  }

  return result;
};

export const outputFileFrom = (argumentsList: string[]): string => {
  const flag = argumentsList.find((argument) => argument.startsWith('--outputFile='));

  if (flag == null) {
    throw new Error('vitest was spawned without an --outputFile flag');
  }

  return flag.slice('--outputFile='.length);
};

export const fakeSpawn =
  ({ report, ...result }: Partial<SpawnResult> & { report?: unknown }): SpawnCommand =>
  async (command, argumentsList) => {
    if (report !== undefined) {
      await writeFile(outputFileFrom(argumentsList), JSON.stringify(report));
    }

    return {
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
      command: ['fake-runner', command, ...argumentsList],
      started: true,
      stdoutTruncated: false,
      stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
      stderrBytes: Buffer.byteLength(result.stderr ?? ''),
      ...result,
    };
  };

export const makeDeps = (overrides: Partial<RunnerDeps>): RunnerDeps => ({
  resolveVitest: () => ({ path: '/fake/vitest.js', version: '4.1.11' }),
  spawn: fakeSpawn({}),
  timeoutMs: 30_000,
  ...overrides,
});
