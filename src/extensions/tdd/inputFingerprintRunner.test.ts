import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { fingerprintInputs } from './inputFingerprint.js';
import { nextestRunner } from './runner/nextest.js';
import type { TestRunner } from './runner/types.js';
import { vitestRunner } from './runner/vitest.js';

vi.mock(import('./runner/runners.js'), async (importOriginal) => {
  const original = await importOriginal();

  const fakeRunner: TestRunner = {
    ...original.runners.vitest,
    name: 'fake',
    defaults: { ...original.runners.vitest.defaults, runner: 'fake' },
    configurationGlobs: ['**/only-fake.config.ts'],
  };

  return {
    ...original,
    lookupRunner: (name: string) => (name === 'fake' ? fakeRunner : original.lookupRunner(name)),
  };
});

it('fingerprints only the configuration globs of the selected runner', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-runner-');
  await writeFile(join(cwd, 'only-fake.config.ts'), 'one');
  await writeFile(join(cwd, 'vite.config.ts'), 'one');

  const config = {
    ...vitestRunner.defaults,
    runner: 'fake',
    productionGlobs: [],
    testGlobs: [],
    testSupportGlobs: [],
    excludedGlobs: [],
  };

  const before = await fingerprintInputs(cwd, config, []);

  await writeFile(join(cwd, 'only-fake.config.ts'), 'two');
  const afterSelected = await fingerprintInputs(cwd, config, []);

  await writeFile(join(cwd, 'vite.config.ts'), 'two');
  const afterVitestOnly = await fingerprintInputs(cwd, config, []);

  expect(afterSelected).not.toBe(before);
  expect(afterVitestOnly).toBe(afterSelected);
});

it.for(['.cargo/config', '.cargo/config.toml'])(
  'fingerprints the nextest Cargo config file %s',
  async (file, { onTestFinished }) => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-nextest-');
    await mkdir(join(cwd, '.cargo'));
    await writeFile(join(cwd, file), 'one');

    const before = await fingerprintInputs(cwd, nextestRunner.defaults, []);

    await writeFile(join(cwd, file), 'two');
    const after = await fingerprintInputs(cwd, nextestRunner.defaults, []);

    expect(after).not.toBe(before);
  },
);
