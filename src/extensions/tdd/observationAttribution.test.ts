import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { createTestObservation } from './observation.js';
import type { RunnerResult, TestAttribution, TestRunner } from './runner/types.js';

const runTests = vi.hoisted(() => vi.fn<TestRunner['run']>());

vi.mock(import('./runner/runners.js'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    lookupRunner: () => ({ ...original.lookupRunner('vitest'), run: runTests }),
  };
});

const behavior = { behavior: 'value', testFullName: 'value works', files: ['value.test.ts'] };

const failResult = (attribution?: TestAttribution): RunnerResult => ({
  kind: 'fail',
  tests: [
    {
      file: 'value.test.ts',
      fullname: 'value works',
      status: 'failed',
      ...(attribution === undefined ? {} : { attribution }),
    },
  ],
  failures: [],
  truncated: false,
});

const setup = async (cleanup: TestContext['onTestFinished']) => {
  const cwd = temporaryDirectory(cleanup, 'tau-observation-attribution-');

  await writeFile(join(cwd, 'value.test.ts'), 'test');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/value.ts'), 'before');

  return { cwd, observation: createTestObservation(cwd) };
};

const checkpointAfterFailure = async (
  attribution: TestAttribution | undefined,
  cleanup: TestContext['onTestFinished'],
) => {
  const { cwd, observation } = await setup(cleanup);

  vi.mocked(runTests).mockResolvedValueOnce(failResult(attribution));

  await observation.run(behavior, 'focused');
  await writeFile(join(cwd, 'src/value.ts'), 'implementation');

  return observation.checkpoint(true);
};

beforeEach(() => {
  vi.mocked(runTests).mockReset();
});

it.for<{ name: string; attribution: TestAttribution | undefined }>([
  { name: 'an exact result', attribution: undefined },
])('$name records RED', async ({ attribution }, { onTestFinished }) => {
  expect(await checkpointAfterFailure(attribution, onTestFinished)).toBeUndefined();
});

it.for<{ name: string; attribution: TestAttribution }>([
  {
    name: 'an ambiguous result',
    attribution: { kind: 'ambiguous', binaryIds: ['demo', 'demo::bin/tool'] },
  },
  {
    name: 'an unknown result',
    attribution: { kind: 'unknown', reason: 'no dep-info' },
  },
])('$name records no RED', async ({ attribution }, { onTestFinished }) => {
  expect(await checkpointAfterFailure(attribution, onTestFinished)).toContain('stale');
});
