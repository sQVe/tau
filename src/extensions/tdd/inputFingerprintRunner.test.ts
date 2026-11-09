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

it.for([
  'Cargo.lock',
  'Cargo.toml',
  'build.rs',
  '.config/nextest.toml',
  '.cargo/config',
  '.cargo/config.toml',
  'rust-toolchain',
  'rust-toolchain.toml',
])('fingerprints %s next to the chosen Cargo manifest', async (file, { onTestFinished }) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-manifest-');
  const config = { ...nextestRunner.defaults, cargoManifestPath: 'backend/Cargo.toml' };
  await mkdir(join(cwd, 'backend', '.config'), { recursive: true });
  await mkdir(join(cwd, 'backend', '.cargo'));
  await writeFile(join(cwd, 'backend', file), 'one');

  const before = await fingerprintInputs(cwd, config, []);

  await writeFile(join(cwd, 'backend', file), 'two');
  const after = await fingerprintInputs(cwd, config, []);

  expect(after).not.toBe(before);
});

it('fingerprints a Cargo.lock that appears next to the chosen Cargo manifest', async ({
  onTestFinished,
}) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-manifest-');
  const config = { ...nextestRunner.defaults, cargoManifestPath: 'backend/Cargo.toml' };
  await mkdir(join(cwd, 'backend'));

  const before = await fingerprintInputs(cwd, config, []);

  await writeFile(join(cwd, 'backend', 'Cargo.lock'), 'version = 4\n');
  const after = await fingerprintInputs(cwd, config, []);

  expect(after).not.toBe(before);
});

it.for(['backend', ''])(
  'fingerprints the workspace Cargo.lock in %j above the chosen member manifest',
  async (workspace, { onTestFinished }) => {
    const root = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-workspace-');
    const cwd = join(root, 'sub');
    const config = { ...nextestRunner.defaults, cargoManifestPath: 'backend/member/Cargo.toml' };
    await mkdir(join(root, 'backend', 'member'), { recursive: true });
    await mkdir(cwd);

    const before = await fingerprintInputs(cwd, config, [], root);

    await writeFile(join(root, workspace, 'Cargo.lock'), 'version = 4\n');
    const created = await fingerprintInputs(cwd, config, [], root);

    await writeFile(join(root, workspace, 'Cargo.lock'), 'version = 3\n');
    const changed = await fingerprintInputs(cwd, config, [], root);

    expect(created).not.toBe(before);
    expect(changed).not.toBe(created);
  },
);

it.for([
  { name: 'a member session', manifest: undefined },
  { name: 'a chosen member manifest', manifest: 'pkg_b/Cargo.toml' },
])(
  'fingerprints the parent workspace Cargo.toml above $name',
  async ({ manifest }, { onTestFinished }) => {
    const root = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-workspace-manifest-');
    const cwd = join(root, manifest === undefined ? 'pkg_b' : 'other');
    const chosen = manifest === undefined ? {} : { cargoManifestPath: manifest };
    const config = { ...nextestRunner.defaults, ...chosen };
    await mkdir(join(root, 'pkg_b'));
    await mkdir(join(root, 'other'));

    const before = await fingerprintInputs(cwd, config, [], root);

    await writeFile(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["pkg_b"]\n');
    const created = await fingerprintInputs(cwd, config, [], root);

    await writeFile(join(root, 'Cargo.toml'), '[workspace]\nmembers = []\n');
    const changed = await fingerprintInputs(cwd, config, [], root);

    expect(created).not.toBe(before);
    expect(changed).not.toBe(created);
  },
);

it('fingerprints the workspace Cargo.lock above a member session without a chosen manifest', async ({
  onTestFinished,
}) => {
  const root = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-member-session-');
  const cwd = join(root, 'pkg_b');
  await mkdir(cwd);

  const before = await fingerprintInputs(cwd, nextestRunner.defaults, [], root);

  await writeFile(join(root, 'Cargo.lock'), 'version = 4\n');
  const after = await fingerprintInputs(cwd, nextestRunner.defaults, [], root);

  expect(after).not.toBe(before);
});

it.for(['.cargo/config', '.cargo/config.toml'])(
  'fingerprints the repository root %s from a nested session',
  async (file, { onTestFinished }) => {
    const root = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-root-config-');
    const cwd = join(root, 'sub');
    await mkdir(join(root, '.cargo'));
    await mkdir(cwd);

    const before = await fingerprintInputs(cwd, nextestRunner.defaults, [], root);

    await writeFile(join(root, file), '[env]\nPROBE = "one"\n');
    const created = await fingerprintInputs(cwd, nextestRunner.defaults, [], root);

    await writeFile(join(root, file), '[env]\nPROBE = "two"\n');
    const changed = await fingerprintInputs(cwd, nextestRunner.defaults, [], root);

    expect(created).not.toBe(before);
    expect(changed).not.toBe(created);
  },
);

it('fingerprints no Cargo.lock above the repository root', async ({ onTestFinished }) => {
  const outer = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-outer-');
  const root = join(outer, 'repo');
  const config = { ...nextestRunner.defaults, cargoManifestPath: 'backend/Cargo.toml' };
  await mkdir(join(root, 'backend'), { recursive: true });

  const before = await fingerprintInputs(root, config, [], root);

  await writeFile(join(outer, 'Cargo.lock'), 'version = 4\n');
  const after = await fingerprintInputs(root, config, [], root);

  expect(after).toBe(before);
});

it('fingerprints no Cargo.lock above a chosen manifest outside the repository root', async ({
  onTestFinished,
}) => {
  const outer = temporaryDirectory(onTestFinished, 'tau-input-fingerprint-outside-');
  const root = join(outer, 'repo');
  const config = { ...nextestRunner.defaults, cargoManifestPath: '../outside/member/Cargo.toml' };
  await mkdir(root);
  await mkdir(join(outer, 'outside', 'member'), { recursive: true });

  const before = await fingerprintInputs(root, config, [], root);

  await writeFile(join(outer, 'outside', 'Cargo.lock'), 'version = 4\n');
  const after = await fingerprintInputs(root, config, [], root);

  expect(after).toBe(before);
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
