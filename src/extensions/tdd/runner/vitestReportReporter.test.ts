import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from '../config.js';
import { runTests } from '../fixtures/vitestRunner.js';
import { extractBinPath } from './resolution.js';
import { defaultDeps } from './vitest.js';
import { loadJsonReporter } from './vitestReportReporter.js';

type LoadOutcome = { JsonReporter?: unknown } | { error: unknown };
type ReporterEntry = 'vitest/node' | 'vitest/reporters';

const verificationArgv = defaultTddConfig.verificationArgv;

const installedRequire = createRequire(import.meta.url);
const installedDirectory = dirname(installedRequire.resolve('vitest/package.json'));

const reporterConstructor = () => undefined;

const codedError = (code: string): Error => Object.assign(new Error('load failed'), { code });

const outcomesToLoad =
  (outcomes: Record<string, LoadOutcome>) =>
  (specifier: string): unknown => {
    const outcome = outcomes[specifier];

    if (outcome !== undefined && 'error' in outcome) {
      throw outcome.error;
    }

    return outcome ?? {};
  };

const failureMessageFrom = (load: (specifier: string) => unknown): string => {
  try {
    loadJsonReporter(load);
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }

  throw new TypeError('Expected loadJsonReporter to refuse every entry.');
};

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
  `export { JsonReporter } from ${JSON.stringify(join(installedDirectory, 'dist', 'node.js'))};\n`;

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

  const exportsFromReportersEntry = entry === 'vitest/reporters';

  const exports = {
    '.': './index.js',
    './node': './node.js',
    './package.json': './package.json',
    ...(exportsFromReportersEntry ? { './reporters': './reporters.js' } : {}),
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

  if (exportsFromReportersEntry) {
    await writeFile(join(packageDirectory, 'reporters.js'), jsonReporterReexport());
  }

  await writeFile(join(cwd, 'vitest.config.mjs'), 'export default { test: { globals: true } };\n');

  await writeFile(join(cwd, 'value.test.ts'), "it('adds', () => { expect(1 + 1).toBe(2); });\n");

  return cwd;
};

describe('loadJsonReporter', () => {
  it.for([
    {
      name: 'the first entry that exports it',
      outcomes: { 'vitest/node': { JsonReporter: reporterConstructor } },
    },
    {
      name: 'the second entry when the first has no export',
      outcomes: {
        'vitest/node': {},
        'vitest/reporters': { JsonReporter: reporterConstructor },
      },
    },
    {
      name: 'the second entry when the first fails to load',
      outcomes: {
        'vitest/node': { error: codedError('ERR_PACKAGE_PATH_NOT_EXPORTED') },
        'vitest/reporters': { JsonReporter: reporterConstructor },
      },
    },
  ])('takes the JSON reporter from $name', ({ outcomes }) => {
    expect(loadJsonReporter(outcomesToLoad(outcomes))).toBe(reporterConstructor);
  });

  it('stops at the first entry that exports the JSON reporter', () => {
    const calls: string[] = [];

    loadJsonReporter((specifier) => {
      calls.push(specifier);

      return { JsonReporter: reporterConstructor };
    });

    expect(calls).toEqual(['vitest/node']);
  });

  it.for([
    {
      name: 'neither entry exports it',
      outcomes: {},
      details: [
        'vitest/node: no JSON reporter export',
        'vitest/reporters: no JSON reporter export',
      ],
      forbidden: [],
    },
    {
      name: 'the export is not a constructor',
      outcomes: { 'vitest/node': { JsonReporter: 'not a function' } },
      details: ['vitest/node: no JSON reporter export'],
      forbidden: [],
    },
    {
      name: 'an entry fails to load with a code',
      outcomes: { 'vitest/node': { error: codedError('ERR_MODULE_NOT_FOUND') } },
      details: ['vitest/node: load failed (ERR_MODULE_NOT_FOUND)'],
      forbidden: [],
    },
    {
      name: 'an entry fails to load without a code',
      outcomes: { 'vitest/node': { error: new Error('a message that must not reach the user') } },
      details: ['vitest/node: load failed (no error code)'],
      forbidden: ['a message that must not reach the user'],
    },
  ])(
    'names why no entry supplies the JSON reporter when $name',
    ({ outcomes, details, forbidden }) => {
      const message = failureMessageFrom(outcomesToLoad(outcomes));

      for (const detail of details) {
        expect(message).toContain(detail);
      }

      for (const text of forbidden) {
        expect(message).not.toContain(text);
      }
    },
  );
});

describe('report reporter', () => {
  beforeEach(() => {
    vi.stubEnv('PI_CODING_AGENT_DIR', temporaryDirectory(onTestFinished, 'tau-report-agent-'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.for([{ entry: 'vitest/node' as const }, { entry: 'vitest/reporters' as const }])(
    'records observations in a project whose Vitest exports the reporter from $entry',
    { timeout: 125_000 },
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
