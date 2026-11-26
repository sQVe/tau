import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from '../config.js';
import { runTests } from '../fixtures/vitestRunner.js';
import { extractBinPath } from './resolution.js';
import { defaultDeps } from './vitest.js';

const verificationArgv = defaultTddConfig.verificationArgv;

const installedRequire = createRequire(import.meta.url);
const installedDirectory = dirname(installedRequire.resolve('vitest/package.json'));

const installedManifest = async (): Promise<unknown> => {
  const text = await readFile(join(installedDirectory, 'package.json'), 'utf8');
  const manifest: unknown = JSON.parse(text);

  return manifest;
};

const manifestVersion = (manifest: unknown): string => {
  const version =
    manifest !== null && typeof manifest === 'object' && 'version' in manifest
      ? manifest.version
      : undefined;

  if (typeof version !== 'string') {
    throw new TypeError('The installed Vitest manifest has no version.');
  }

  return version;
};

// The installed Vitest binary, described by a package whose exports omit "./reporters", stands in
// for a project that pins a Vitest release without that entry, such as Vitest 5. Its "./node" entry
// re-exports the installed JSON reporter, so the run writes a real report.
const createProjectWithoutReportersEntry = async () => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-report-reporter-');
  const packageDirectory = join(cwd, 'node_modules', 'vitest');
  const manifest = await installedManifest();
  const binary = extractBinPath(manifest);

  if (binary === null) {
    throw new TypeError('The installed Vitest manifest has no bin entry.');
  }

  await mkdir(packageDirectory, { recursive: true });

  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'vitest',
      version: manifestVersion(manifest),
      type: 'module',
      bin: { vitest: './vitest.mjs' },
      exports: {
        '.': './index.js',
        './node': './node.js',
        './package.json': './package.json',
      },
    }),
  );

  await symlink(join(installedDirectory, binary), join(packageDirectory, 'vitest.mjs'));
  await writeFile(join(packageDirectory, 'index.js'), 'export {};\n');

  await writeFile(
    join(packageDirectory, 'node.js'),
    `export { JsonReporter } from ${JSON.stringify(join(installedDirectory, 'dist', 'reporters.js'))};\n`,
  );

  await writeFile(join(cwd, 'vitest.config.mjs'), 'export default { test: { globals: true } };\n');

  await writeFile(join(cwd, 'value.test.ts'), "it('adds', () => { expect(1 + 1).toBe(2); });\n");

  return cwd;
};

describe('report reporter', () => {
  beforeEach(() => {
    vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(onTestFinished, 'tau-report-agent-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    'records observations where the project Vitest package exports no reporters entry',
    { timeout: 30_000 },
    async () => {
      const cwd = await createProjectWithoutReportersEntry();

      const result = await runTests(
        { scope: 'full', verificationArgv, cwd },
        { ...defaultDeps('full'), timeoutMs: 30_000 },
      );

      expect(result).toMatchObject({
        kind: 'pass',
        tests: [{ file: join(cwd, 'value.test.ts'), fullname: 'adds', status: 'passed' }],
      });
    },
  );
});
