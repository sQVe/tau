import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { JsonReporter } from 'vitest/node';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from '../config.js';
import { runTests } from '../fixtures/vitestRunner.js';
import { extractBinPath } from './resolution.js';
import { defaultDeps } from './vitest.js';
import reportReporter from './vitestReportReporter.js';

type ReporterEntry = 'vitest/node' | 'vitest/reporters';

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

const jsonReporterReexport = () =>
  `export { JsonReporter } from ${JSON.stringify(join(installedDirectory, 'dist', 'reporters.js'))};\n`;

// The installed Vitest binary behind a package that exports the JSON reporter from one entry stands
// in for a project that pins another Vitest release: Vitest 5 exports it from "vitest/node" only,
// and Vitest 4.0 from "vitest/reporters" only. The "./node" entry of the 4.0 shape has no
// JsonReporter, as in that release.
const createProjectExportingReporterFrom = async (entry: ReporterEntry) => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-report-reporter-');
  const packageDirectory = join(cwd, 'node_modules', 'vitest');
  const manifest = await installedManifest();
  const binary = extractBinPath(manifest);

  if (binary === null) {
    throw new TypeError('The installed Vitest manifest has no bin entry.');
  }

  const exports = {
    '.': './index.js',
    './node': './node.js',
    './package.json': './package.json',
    ...(entry === 'vitest/reporters' ? { './reporters': './reporters.js' } : {}),
  };

  await mkdir(packageDirectory, { recursive: true });

  await writeFile(
    join(packageDirectory, 'package.json'),
    JSON.stringify({
      name: 'vitest',
      version: manifestVersion(manifest),
      type: 'module',
      bin: { vitest: './vitest.mjs' },
      exports,
    }),
  );

  await symlink(join(installedDirectory, binary), join(packageDirectory, 'vitest.mjs'));
  await writeFile(join(packageDirectory, 'index.js'), 'export {};\n');

  const nodeEntry = entry === 'vitest/node' ? jsonReporterReexport() : 'export {};\n';

  await writeFile(join(packageDirectory, 'node.js'), nodeEntry);

  if (entry === 'vitest/reporters') {
    await writeFile(join(packageDirectory, 'reporters.js'), jsonReporterReexport());
  }

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

  it('exports the JSON reporter of the Vitest installed for the working directory', () => {
    expect(reportReporter).toBe(JsonReporter);
  });

  it.for([{ entry: 'vitest/node' as const }, { entry: 'vitest/reporters' as const }])(
    'records observations in a project whose Vitest exports the reporter from $entry',
    { timeout: 30_000 },
    async ({ entry }) => {
      const cwd = await createProjectExportingReporterFrom(entry);

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
