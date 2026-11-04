import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExtensionContext, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { fakeExtensionApi } from '../../../tests/extensionApi.js';
import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import type { TestRunner } from './runner/types.js';
import { vitestRunner } from './runner/vitest.js';
import tddExtension from './tdd.js';

const overrides = vi.hoisted(() => ({ runner: undefined as TestRunner | undefined }));
const runTests = vi.hoisted(() => vi.fn<TestRunner['run']>());

vi.mock(import('./runner/runners.js'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    lookupRunner: () => overrides.runner ?? original.lookupRunner('vitest'),
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

  const run = (cwd: string) => {
    if (tool === undefined) {
      throw new Error('Missing test tool');
    }

    return tool.execute(
      'run',
      {
        behavior: 'value',
        testFullName: 'works',
        files: ['src/example.test.ts'],
        scope: 'focused',
      },
      undefined,
      undefined,
      contextFor(cwd),
    );
  };

  const edit = (cwd: string) =>
    fake.handler('tool_result')(
      {
        toolName: 'write',
        input: { path: 'src/example.test.ts' },
        isError: false,
        content: [{ type: 'text', text: 'Original result' }],
      },
      contextFor(cwd),
    );

  return { run, edit, notify };
};

it('accepts a file matching both glob lists in run_tests files and fires the production checkpoint on a real edit', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-file-roles-overlap-');
  await mkdir(join(cwd, 'src'));
  await writeFile(join(cwd, 'src/example.test.ts'), 'test');

  overrides.runner = { ...vitestRunner, testFilesCanBeProduction: true, run: runTests };

  runTests.mockResolvedValueOnce({
    kind: 'pass',
    tests: [{ file: 'src/example.test.ts', fullname: 'works', status: 'passed' }],
  });

  const application = setup();

  await application.run(cwd);

  expect(runTests).toHaveBeenLastCalledWith(
    expect.objectContaining({ files: ['src/example.test.ts'] }),
  );

  const patch = await application.edit(cwd);

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

  overrides.runner = { ...vitestRunner, run: runTests };

  runTests.mockResolvedValueOnce({
    kind: 'pass',
    tests: [{ file: 'src/example.test.ts', fullname: 'works', status: 'passed' }],
  });

  const application = setup();

  await application.run(cwd);

  expect(await application.edit(cwd)).toBeUndefined();
  expect(application.notify).not.toHaveBeenCalled();
});
