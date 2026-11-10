import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from '../config.js';
import { runTests } from '../fixtures/vitestRunner.js';
import { defaultDeps } from './vitest.js';

const verificationArgv = defaultTddConfig.verificationArgv;

const createProject = async () => {
  const cwd = temporaryDirectory(onTestFinished, 'tau-focused-runner-');

  await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');

  return cwd;
};

describe('focused Vitest entry', () => {
  beforeEach(() => {
    const agentDirectory = temporaryDirectory(onTestFinished, 'tau-focused-agent-');

    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.for([
    { source: 'value.ts', expectedKind: 'pass', expectedFiles: ['value.test.ts'] },
    { source: 'unrelated.ts', expectedKind: 'no-tests-collected', expectedFiles: [] },
  ])(
    'keeps requested files separate from related source $source',
    async ({ source, expectedKind, expectedFiles }) => {
      const cwd = await createProject();

      await writeFile(join(cwd, 'value.ts'), 'export const value = 1;');
      await writeFile(join(cwd, 'unrelated.ts'), 'export const unrelated = 2;');

      await writeFile(
        join(cwd, 'value.test.ts'),
        "import { it, expect } from 'vitest'; import { value } from './value'; it('works', () => expect(value).toBe(1));",
      );

      await writeFile(
        join(cwd, 'other-value.test.ts'),
        "import { it } from 'vitest'; import './value'; it('works', () => { throw new Error('must not run'); });",
      );

      const result = await runTests({
        scope: 'focused',
        verificationArgv: [
          'vitest',
          'related',
          source,
          '--run',
          '--reporter=json',
          '--reporter=default',
          '--no-color',
        ],
        cwd,
        files: ['value.test.ts'],
        testNames: ['works'],
      });

      const expectedTests = expectedFiles.map((file) => ({
        file: join(cwd, file),
        fullname: 'works',
        status: 'passed',
      }));

      expect(result).toMatchObject({ kind: expectedKind, tests: expectedTests });
      expect('tests' in result && result.tests).toHaveLength(expectedFiles.length);
    },
  );

  it('fails coverage thresholds that include untested source files', async () => {
    const cwd = await createProject();

    await writeFile(
      join(cwd, 'vitest.config.mjs'),
      `export default { test: {
      coverage: { enabled: true, provider: 'v8', include: ['*.ts'],
        reporter: ['json-summary'], thresholds: { lines: 100 } }
    } };`,
    );

    await writeFile(join(cwd, 'value.ts'), 'export const value = 1;');
    await writeFile(join(cwd, 'untested.ts'), 'export function untested() { return 2; }');

    await writeFile(
      join(cwd, 'value.test.ts'),
      "import { it, expect } from 'vitest'; import { value } from './value'; it('works', () => expect(value).toBe(1));",
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv,
      cwd,
      files: ['value.test.ts'],
      testNames: ['works'],
    });

    expect(result).toMatchObject({
      kind: 'compile-error',
      tests: [{ fullname: 'works', status: 'passed' }],
    });

    const summaryPath = join(cwd, 'coverage/coverage-summary.json');
    const summary: unknown = JSON.parse(await readFile(summaryPath, 'utf8'));

    expect(summary).toMatchObject({ total: { lines: { pct: 50 } } });
  });

  it('does not start an unrelated browser provider for a selected node test', async () => {
    const cwd = await createProject();

    await writeFile(
      join(cwd, 'vitest.config.mjs'),
      `
      import { defineBrowserProvider } from '@vitest/browser';
      export default { test: { projects: [
        { test: { name: 'node', include: ['value.test.ts'] } },
        { test: { name: 'browser', include: ['browser.test.ts'], browser: {
          enabled: true, provider: defineBrowserProvider({ name: 'refuses-startup',
            providerFactory() { throw new Error('unselected browser provider initialized'); } }),
          instances: [{ browser: 'chromium' }]
        } } }
      ] } };`,
    );

    await writeFile(
      join(cwd, 'browser.test.ts'),
      "import { it } from 'vitest'; it('works', () => { throw new Error('must not run'); });",
    );

    await writeFile(
      join(cwd, 'value.test.ts'),
      "import { it } from 'vitest'; it('works', () => {});",
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv,
      cwd,
      files: ['value.test.ts'],
      testNames: ['works'],
    });

    expect(result).toMatchObject({
      kind: 'pass',
      tests: [{ fullname: 'works', status: 'passed' }],
    });

    expect('tests' in result && result.tests).toHaveLength(1);
  });

  it.for([
    {
      name: 'configured include',
      configuration: "{ test: { include: ['other.test.ts'] } }",
      file: 'value.test.ts',
      kind: 'no-tests-collected',
    },
    {
      name: 'per-project includes',
      configuration:
        "{ test: { projects: [{ test: { name: 'one', include: ['other.test.ts'] } }, { test: { name: 'two', include: ['value.test.ts'] } }] } }",
      file: 'value.test.ts',
      kind: 'pass',
    },
    {
      name: 'literal path in test directory',
      configuration: "{ test: { dir: 'cases' } }",
      file: 'cases/value[1].test.ts',
      kind: 'pass',
    },
    {
      name: 'configured root and directory',
      configuration: "{ root: './project', test: { dir: './project/tests' } }",
      file: 'project/tests/value.test.ts',
      kind: 'pass',
    },
  ])('keeps exact selection within $name', async ({ configuration, file, kind }) => {
    const cwd = await createProject();

    await mkdir(join(cwd, 'cases'), { recursive: true });
    await mkdir(join(cwd, 'project/tests'), { recursive: true });
    await writeFile(join(cwd, 'vitest.config.mjs'), `export default ${configuration};`);
    await writeFile(join(cwd, file), "import { it } from 'vitest'; it('works', () => {});");

    await writeFile(
      join(cwd, 'other.test.ts'),
      "import { it } from 'vitest'; it('works', () => { throw new Error('must not run'); });",
    );

    await writeFile(
      join(cwd, 'cases/value1.test.ts'),
      "import { it } from 'vitest'; it('works', () => { throw new Error('must not run'); });",
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv: [...verificationArgv, '--passWithNoTests'],
      cwd,
      files: [file],
      testNames: ['works'],
    });

    expect(result.kind).toBe(kind);
    const expectedCount = kind === 'pass' ? 1 : 0;

    expect('tests' in result && result.tests).toHaveLength(expectedCount);
  });

  it('selects exact files for typecheck-only runs', async () => {
    const cwd = await createProject();

    await writeFile(
      join(cwd, 'vitest.config.mjs'),
      `export default { test: {
      typecheck: { enabled: true, only: true, include: ['*.test-d.ts'] }
    } };`,
    );

    await writeFile(
      join(cwd, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['*.test-d.ts'],
      }),
    );

    const contents =
      "import { it, expectTypeOf } from 'vitest'; it('works', () => { expectTypeOf(1).toEqualTypeOf<number>(); });";

    await writeFile(join(cwd, 'value.test-d.ts'), contents);
    await writeFile(join(cwd, 'other-value.test-d.ts'), contents);

    const result = await runTests({
      scope: 'focused',
      verificationArgv,
      cwd,
      files: ['value.test-d.ts'],
      testNames: ['value.test-d.ts works'],
    });

    expect(result).toMatchObject({
      kind: 'pass',
      tests: [
        { file: join(cwd, 'value.test-d.ts'), fullname: 'value.test-d.ts works', status: 'passed' },
      ],
    });

    expect('tests' in result && result.tests).toHaveLength(1);

    const reportFile = result.diagnostics?.report.file;

    if (reportFile === undefined) {
      throw new Error('Expected a saved Vitest report.');
    }

    const report: unknown = JSON.parse(await readFile(reportFile.path, 'utf8'));

    expect(report).toMatchObject({ numTotalTests: 1 });
  });

  it('preserves configured reporters when CLI reporter flags are absent', async () => {
    const cwd = await createProject();
    const marker = join(cwd, 'reporter-finished');

    await writeFile(
      join(cwd, 'vitest.config.mjs'),
      `
      import { writeFileSync } from 'node:fs';
      export default { test: { reporters: ['json', {
        onTestRunEnd() { writeFileSync(${JSON.stringify(marker)}, 'finished'); }
      }] } };`,
    );

    await writeFile(
      join(cwd, 'value.test.ts'),
      "import { it } from 'vitest'; it('works', () => {});",
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv: ['vitest', 'run', '--no-color'],
      cwd,
      files: ['value.test.ts'],
      testNames: ['works'],
    });

    expect(result).toMatchObject({ kind: 'pass' });
    expect(await readFile(marker, 'utf8')).toBe('finished');
  });

  it('exits on startup errors even when configuration leaves a live handle', async () => {
    const cwd = await createProject();

    await writeFile(
      join(cwd, 'vitest.config.mjs'),
      "setInterval(() => {}, 1000); throw new Error('startup failure');",
    );

    const result = await runTests(
      { scope: 'focused', verificationArgv, cwd, files: ['value.test.ts'], testNames: ['works'] },
      { ...defaultDeps(), timeoutMs: 3000 },
    );

    expect(result).toMatchObject({ kind: 'compile-error', tests: [] });
  });

  it('exits after passing tests when configuration leaves a live handle', async () => {
    const cwd = await createProject();

    await writeFile(
      join(cwd, 'vitest.config.mjs'),
      'setInterval(() => {}, 1000); export default { test: { teardownTimeout: 100 } };',
    );

    await writeFile(
      join(cwd, 'value.test.ts'),
      "import { it } from 'vitest'; it('works', () => {});",
    );

    const result = await runTests(
      { scope: 'focused', verificationArgv, cwd, files: ['value.test.ts'], testNames: ['works'] },
      { ...defaultDeps(), timeoutMs: 3000 },
    );

    expect(result).toMatchObject({
      kind: 'pass',
      tests: [{ fullname: 'works', status: 'passed' }],
    });
  });

  it.for([
    {
      name: 'additive CLI exclusions',
      configuration: "exclude: ['value.test.ts']",
      flags: ['--exclude', 'unrelated/**'],
    },
    { name: 'configured source relevance', configuration: "related: ['unrelated.ts']", flags: [] },
  ])('preserves $name', async ({ configuration, flags }) => {
    const cwd = await createProject();

    await writeFile(
      join(cwd, 'vitest.config.mjs'),
      `export default { test: { ${configuration} } };`,
    );

    await writeFile(join(cwd, 'unrelated.ts'), 'export const value = 1;');

    await writeFile(
      join(cwd, 'value.test.ts'),
      "import { it } from 'vitest'; it('works', () => { throw new Error('must not run'); });",
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv: [...verificationArgv, '--passWithNoTests', ...flags],
      cwd,
      files: ['value.test.ts'],
      testNames: ['works'],
    });

    expect(result).toMatchObject({ kind: 'no-tests-collected', tests: [] });
  });

  it.for([
    { name: 'absent', environment: undefined, expected: 'test' },
    { name: 'custom', environment: 'custom', expected: 'custom' },
  ])('sets the configuration environment for $name NODE_ENV', async ({ environment, expected }) => {
    vi.stubEnv('NODE_ENV', environment);
    const cwd = await createProject();

    await writeFile(
      join(cwd, 'vitest.config.mjs'),
      `if (process.env.NODE_ENV !== ${JSON.stringify(expected)}) throw new Error('wrong NODE_ENV');
       export default {};`,
    );

    await writeFile(
      join(cwd, 'value.test.ts'),
      "import { it } from 'vitest'; it('works', () => {});",
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv,
      cwd,
      files: ['value.test.ts'],
      testNames: ['works'],
    });

    expect(result).toMatchObject({ kind: 'pass' });
  });

  it('honors CLI options and exact test names for dash-leading files', async () => {
    const cwd = await createProject();

    await writeFile(
      join(cwd, '-value.test.ts'),
      `it('works [exact]', () => expect(1).toBe(1));
       it('works [exact] suffix', () => { throw new Error('must not run'); });`,
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv: [...verificationArgv, '--globals'],
      cwd,
      files: ['-value.test.ts'],
      testNames: ['works [exact]'],
    });

    expect(result).toMatchObject({
      kind: 'pass',
      tests: [{ file: join(cwd, '-value.test.ts'), fullname: 'works [exact]', status: 'passed' }],
    });

    expect('tests' in result && result.tests).toHaveLength(1);
  });

  it.for([
    { file: 'missing.test.ts', flags: [], kind: 'compile-error' },
    { file: 'value.test.ts', flags: [], kind: 'compile-error' },
    { file: 'value.test.ts', flags: ['--passWithNoTests'], kind: 'no-tests-collected' },
  ])('preserves the $kind result for absent $file', async ({ file, flags, kind }) => {
    const cwd = await createProject();

    await writeFile(
      join(cwd, 'other-value.test.ts'),
      "import { it } from 'vitest'; it('works', () => { throw new Error('must not run'); });",
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv: [...verificationArgv, ...flags],
      cwd,
      files: [file],
      testNames: ['works'],
    });

    expect(result).toMatchObject({ kind, tests: [] });
  });
});
