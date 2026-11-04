import { rm, writeFile } from 'node:fs/promises';

import { onTestFinished } from 'vitest';

import { runners } from '../runner/runners.js';
import type { RunnerResult, RunTestsInput, SpawnCommand, SpawnResult } from '../runner/types.js';

type RunnerDeps = NonNullable<Parameters<typeof runners.vitest.run>[1]>;

export const runTests = async (
  input: RunTestsInput,
  dependencies?: RunnerDeps,
): Promise<RunnerResult> => {
  const result = await runners.vitest.run(input, dependencies);

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
