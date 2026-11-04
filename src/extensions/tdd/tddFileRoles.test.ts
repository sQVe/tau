import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { TddConfig } from './config.js';
import type { TestRunner } from './runner/types.js';
import { vitestRunner } from './runner/vitest.js';
import tddExtension from './tdd.js';

const fakeDefaults: TddConfig = {
  ...vitestRunner.defaults,
  runner: 'fake',
  productionGlobs: ['**/*.check.ts'],
  testGlobs: ['**/*.check.ts'],
  testSupportGlobs: [],
  excludedGlobs: [],
};

const overrides = vi.hoisted(() => ({
  vitest: undefined as TestRunner | undefined,
  fake: undefined as TestRunner | undefined,
}));

const runTests = vi.hoisted(() => vi.fn<TestRunner['run']>());

vi.mock(import('./runner/runners.js'), async (importOriginal) => {
  const original = await importOriginal();

  const table = (): Record<string, TestRunner> => ({
    vitest: overrides.vitest ?? original.runners.vitest,
    fake: overrides.fake ?? original.runners.vitest,
  });

  return {
    ...original,
    findRunner: (name: string) => table()[name],
    lookupRunner: (name: string) => {
      const runner = table()[name];

      if (runner === undefined) {
        throw new Error(`Unknown TDD runner: ${name}`);
      }

      return runner;
    },
  };
});

const redHint =
  'Hint: No RED observed for this behavior; start the next behavior with a failing focused test.';

const setup = () => {
  const fake = fakeExtensionApi();
  const notify = vi.fn<ExtensionContext['ui']['notify']>();

  // Keep the developer's own user config out of the tests.
  vi.stubEnv('PI_CODING_AGENT_DIR', join(tmpdir(), 'tau-no-agent-directory'));

  tddExtension(fake.pi);
  const tool = fake.tools.get('run_tests');

  const contextFor = (cwd: string) =>
    ({
      cwd,
      hasUI: false,
      ui: { notify },
      isProjectTrusted: () => true,
    }) as unknown as ExtensionContext & ExtensionToolContext;

  const run = (cwd: string, file = 'src/example.test.ts') => {
    if (tool === undefined) {
      throw new Error('Missing test tool');
    }

    return tool.execute(
      'run',
      {
        behavior: 'value',
        testFullName: 'works',
        files: [file],
        scope: 'focused',
      },
      undefined,
      undefined,
      contextFor(cwd),
    );
  };

  const edit = (cwd: string, file = 'src/example.test.ts') =>
    fake.handler('tool_result')(
      {
        toolName: 'write',
        input: { path: file },
        isError: false,
        content: [{ type: 'text', text: 'Original result' }],
      },
      contextFor(cwd),
    );

  return { run, edit, notify };
};

it('calls the selected non-Vitest runner for run_tests', async ({ onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-file-roles-selected-');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/example.check.ts'), 'test');
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'tau.json'), JSON.stringify({ tdd: { runner: 'fake' } }));

  overrides.fake = { ...vitestRunner, name: 'fake', defaults: fakeDefaults, run: runTests };

  runTests.mockResolvedValueOnce({
    kind: 'pass',
    tests: [{ file: 'src/example.check.ts', fullname: 'works', status: 'passed' }],
  });

  const application = setup();

  await application.run(cwd, 'src/example.check.ts');

  expect(runTests).toHaveBeenLastCalledWith(
    expect.objectContaining({ scope: 'focused', files: ['src/example.check.ts'] }),
  );
});

it('accepts a file matching both glob lists in run_tests files and fires the production checkpoint on a real edit', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-file-roles-overlap-');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/example.check.ts'), 'test');
  await mkdir(join(cwd, '.pi'));
  await writeFile(join(cwd, '.pi', 'tau.json'), JSON.stringify({ tdd: { runner: 'fake' } }));

  overrides.fake = {
    ...vitestRunner,
    name: 'fake',
    defaults: fakeDefaults,
    testFilesCanBeProduction: true,
    run: runTests,
  };

  runTests.mockResolvedValueOnce({
    kind: 'pass',
    tests: [{ file: 'src/example.check.ts', fullname: 'works', status: 'passed' }],
  });

  const application = setup();

  await application.run(cwd, 'src/example.check.ts');

  expect(runTests).toHaveBeenLastCalledWith(
    expect.objectContaining({ files: ['src/example.check.ts'] }),
  );

  const patch = await application.edit(cwd, 'src/example.check.ts');

  expect(patch).toEqual({
    content: [
      { type: 'text', text: 'Original result' },
      { type: 'text', text: redHint },
    ],
  });
});

it('leaves a Vitest test file out of the production checkpoint after a run', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-file-roles-vitest-');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/example.test.ts'), 'test');

  overrides.vitest = { ...vitestRunner, run: runTests };

  runTests.mockResolvedValueOnce({
    kind: 'pass',
    tests: [{ file: 'src/example.test.ts', fullname: 'works', status: 'passed' }],
  });

  const application = setup();

  await application.run(cwd);

  expect(await application.edit(cwd)).toBeUndefined();
  expect(application.notify).not.toHaveBeenCalled();
});
