import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from '../config.js';
import { fakeSpawn, makeDeps, runTests } from '../fixtures/vitestRunner.js';
import { thrownErrorType } from '../observation.js';
import { maximumFailures } from './constants.js';
import { defaultSpawn, maximumTotalBytes } from './process.js';
import { nodeExecutable } from './resolution.js';
import type { RunTestsInput, SpawnCommand } from './types.js';
import { defaultDeps } from './vitest.js';

const verificationArgv = defaultTddConfig.verificationArgv;

describe('runTests', () => {
  beforeAll(() => {
    const agentDirectory = temporaryDirectory(afterAll, 'tau-runner-agent-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it.for(['4.1.11', '5.0.1'])(
    'uses Vitest %s native nested names for exact selection and failure identities',
    async (version) => {
      const separator = version.startsWith('5.') ? ' > ' : ' ';
      const fullname = ['outer suite', 'inner [group]', 'works (exact)'].join(separator);
      const filter = `^(?:${fullname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})$`;

      // Vitest 5.0.1 still joins JSON fullName with spaces; CLI filtering uses " > ".
      // https://github.com/vitest-dev/vitest/blob/v5.0.1/packages/vitest/src/node/reporters/json.ts
      const assertion = {
        ancestorTitles: ['outer suite', 'inner [group]'],
        title: 'works (exact)',
        fullName: 'outer suite inner [group] works (exact)',
        status: 'failed',
        failureMessages: ['expected 1 to be 2'],
      };

      const spawn = vi.fn<SpawnCommand>(
        fakeSpawn({
          code: 1,
          report: {
            numTotalTests: 3,
            numFailedTests: 1,
            numPassedTests: 0,
            testResults: [
              {
                name: '/repo/value.test.ts',
                status: 'failed',
                assertionResults: [
                  assertion,
                  {
                    ...assertion,
                    title: 'works (exact) suffix',
                    fullName: `${assertion.fullName} suffix`,
                    status: 'pending',
                    failureMessages: [],
                  },
                  {
                    ...assertion,
                    ancestorTitles: [],
                    title: assertion.fullName,
                    status: 'pending',
                    failureMessages: [],
                  },
                ],
              },
            ],
          },
        }),
      );

      const result = await runTests(
        {
          scope: 'focused',
          verificationArgv,
          cwd: '/repo',
          files: ['value.test.ts'],
          testNames: [fullname],
        },
        makeDeps({ resolveVitest: () => ({ path: '/fake/vitest.js', version }), spawn }),
      );

      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        nodeExecutable(),
        expect.arrayContaining(['/fake/vitest.js', '-t', filter]),
        expect.objectContaining({ cwd: '/repo' }),
      );

      expect(result).toMatchObject({
        kind: 'fail',
        failures: [{ fullname, message: 'expected 1 to be 2' }],
      });

      // V4 cannot distinguish a top-level name containing spaces from the same nested name.
      const expected = [{ file: '/repo/value.test.ts', fullname, status: 'failed' }];

      if (version.startsWith('4.')) {
        expected.push({ file: '/repo/value.test.ts', fullname, status: 'skipped' });
      }

      expect('tests' in result && result.tests).toEqual(expected);
    },
  );

  it.for(['4.1.11', '5.0.1'])(
    'explains unmatched Vitest %s names without retrying or broadening selection',
    async (version) => {
      const spawn = vi.fn<SpawnCommand>(
        fakeSpawn({
          report: {
            numTotalTests: 1,
            numFailedTests: 0,
            numPassedTests: 0,
            testResults: [
              {
                name: '/repo/value.test.ts',
                status: 'passed',
                assertionResults: [
                  {
                    ancestorTitles: ['outer', 'inner'],
                    title: 'works',
                    fullName: 'outer inner works',
                    status: 'pending',
                  },
                ],
              },
            ],
          },
        }),
      );

      const result = await runTests(
        {
          scope: 'focused',
          verificationArgv,
          cwd: '/repo',
          files: ['value.test.ts'],
          testNames: ['wrong nested name'],
        },
        makeDeps({ resolveVitest: () => ({ path: '/fake/vitest.js', version }), spawn }),
      );

      expect(result).toMatchObject({ kind: 'no-tests-collected', tests: [] });
      expect(result).toHaveProperty('message', expect.stringContaining(`Vitest ${version}`));

      expect(result).toHaveProperty(
        'message',
        expect.stringContaining(
          version.startsWith('5.') ? 'outer > inner > works' : 'outer inner works',
        ),
      );

      expect(result).toHaveProperty('message', expect.stringContaining('Do not restructure tests'));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[1]).toContain('^(?:wrong nested name)$');
    },
  );

  it('preserves Vitest 5 literal separators, empty titles, duplicates, and skipped statuses', async () => {
    const assertions = [
      {
        ancestorTitles: [],
        title: 'literal > title',
        fullName: 'literal > title',
        status: 'failed',
      },
      { ancestorTitles: ['outer', ''], title: '', fullName: 'outer ', status: 'failed' },
      {
        ancestorTitles: ['outer'],
        title: 'duplicate',
        fullName: 'outer duplicate',
        status: 'failed',
      },
      {
        ancestorTitles: ['outer'],
        title: 'duplicate',
        fullName: 'outer duplicate',
        status: 'failed',
      },
      { ancestorTitles: ['outer'], title: 'skipped', fullName: 'outer skipped', status: 'pending' },
      { ancestorTitles: ['outer'], title: 'todo', fullName: 'outer todo', status: 'todo' },
    ];

    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: '/repo' },
      makeDeps({
        resolveVitest: () => ({ path: '/fake/vitest.js', version: '5.0.1' }),
        spawn: fakeSpawn({
          code: 1,
          report: {
            numTotalTests: 6,
            numFailedTests: 4,
            numPassedTests: 0,
            testResults: [
              { name: '/repo/value.test.ts', status: 'failed', assertionResults: assertions },
            ],
          },
        }),
      }),
    );

    expect(result).toMatchObject({
      kind: 'fail',
      tests: [
        { fullname: 'literal > title', status: 'failed' },
        { fullname: 'outer >  > ', status: 'failed' },
        { fullname: 'outer > duplicate', status: 'failed' },
        { fullname: 'outer > duplicate', status: 'failed' },
        { fullname: 'outer > skipped', status: 'skipped' },
        { fullname: 'outer > todo', status: 'todo' },
      ],
    });
  });

  it.for(['value.ts', 'related.test.ts'])(
    'runs only tests related to %s with the installed Vitest runner',
    async (file) => {
      const cwd = temporaryDirectory(onTestFinished, 'tau-related-selection-');
      await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');
      await writeFile(join(cwd, 'value.ts'), 'export const value = 1;');

      await writeFile(
        join(cwd, 'related.test.ts'),
        "import { it, expect } from 'vitest'; import { value } from './value'; it('related', () => expect(value).toBe(1));",
      );

      await writeFile(
        join(cwd, 'unrelated.test.ts'),
        "import { it } from 'vitest'; it('unrelated', () => { throw new Error('must not run'); });",
      );

      const result = await runTests({
        scope: 'affected',
        verificationArgv,
        cwd,
        files: [file],
        testNames: ['ignored'],
      });

      expect(result).toMatchObject({
        kind: 'pass',
        tests: [{ file: join(cwd, 'related.test.ts'), fullname: 'related', status: 'passed' }],
      });

      expect('tests' in result && result.tests).toHaveLength(1);
    },
  );

  it('selects only an exact nested test with the installed Vitest runner', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-nested-selection-');
    await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');

    await writeFile(
      join(cwd, 'nested.test.ts'),
      `
      import { describe, it, expect } from 'vitest';
      describe('outer suite', () => describe('inner [group]', () => {
        it('works (exact)', () => expect(1).toBe(2));
        it('works (exact) suffix', () => { throw new Error('must not run'); });
      }));
      it('works (exact)', () => { throw new Error('must not run'); });
    `,
    );

    const result = await runTests({
      scope: 'focused',
      verificationArgv,
      cwd,
      files: ['nested.test.ts'],
      testNames: ['outer suite inner [group] works (exact)'],
    });

    expect(result).toMatchObject({
      kind: 'fail',
      tests: [
        {
          file: join(cwd, 'nested.test.ts'),
          fullname: 'outer suite inner [group] works (exact)',
          status: 'failed',
        },
      ],
    });

    expect('failures' in result && result.failures).toHaveLength(1);

    const unmatched = await runTests({
      scope: 'focused',
      verificationArgv,
      cwd,
      files: ['nested.test.ts'],
      testNames: ['outer suite > inner [group] > works (exact)'],
    });

    expect(unmatched).toMatchObject({ kind: 'no-tests-collected', tests: [] });

    expect(unmatched).toHaveProperty(
      'message',
      expect.stringContaining('outer suite inner [group] works (exact)'),
    );
  });

  it('reports each test duration in whole milliseconds when Vitest gives one', async () => {
    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: '/repo' },
      makeDeps({
        spawn: fakeSpawn({
          report: {
            numTotalTests: 2,
            numFailedTests: 0,
            numPassedTests: 2,
            testResults: [
              {
                name: '/repo/value.test.ts',
                status: 'passed',
                assertionResults: [
                  { fullName: 'timed', status: 'passed', duration: 12.6 },
                  { fullName: 'untimed', status: 'passed', duration: null },
                ],
              },
            ],
          },
        }),
      }),
    );

    expect(result).toMatchObject({ kind: 'pass' });

    expect(result).toHaveProperty('tests', [
      { file: '/repo/value.test.ts', fullname: 'timed', status: 'passed', durationMs: 13 },
      { file: '/repo/value.test.ts', fullname: 'untimed', status: 'passed' },
    ]);
  });

  it('returns every test identity and status from a real four-status fixture', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-runner-');
    const file = join(cwd, 'statuses.test.ts');

    try {
      await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');

      await writeFile(
        file,
        `
        import { describe, expect, it } from 'vitest';
        describe('suite', () => {
          it('passes', () => expect(1).toBe(1));
          it('fails', () => expect(1).toBe(2));
          it.skip('skips', () => {});
          it.todo('later');
        });
      `,
      );

      const result = await runTests({ scope: 'full', verificationArgv, cwd });

      expect(result.kind).toBe('fail');
      const tests = 'tests' in result ? result.tests : [];

      expect(tests.map(({ durationMs: _durationMs, ...identity }) => identity)).toEqual([
        { file, fullname: 'suite passes', status: 'passed' },
        { file, fullname: 'suite fails', status: 'failed' },
        { file, fullname: 'suite skips', status: 'skipped' },
        { file, fullname: 'suite later', status: 'todo' },
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 125_000);

  it.for([
    {
      scenario: 'assertion failure',
      body: 'expect(run()).toBe(2)',
      implementation: 'return 1;',
      expectedType: null,
    },
    {
      scenario: 'production TypeError',
      body: 'run()',
      implementation: 'return null.value;',
      expectedType: 'TypeError',
    },
    {
      scenario: 'missing dynamic import',
      body: "await import('./missing.js')",
      implementation: 'return 1;',
      expectedType: 'Error',
    },
  ])(
    'classifies real Vitest failure messages for $scenario',
    { timeout: 125_000 },
    async (fixture) => {
      const cwd = temporaryDirectory(onTestFinished, 'tau-runner-classification-');

      try {
        await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');

        await writeFile(
          join(cwd, 'value.js'),
          `export function run() { ${fixture.implementation} }`,
        );

        await writeFile(
          join(cwd, 'behavior.test.ts'),
          `import { it, expect } from 'vitest'; import { run } from './value.js';
        it('required behavior', async () => { ${fixture.body}; });`,
        );

        const result = await runTests({ scope: 'full', verificationArgv, cwd });

        expect(result).toMatchObject({
          kind: 'fail',
          failures: [{ fullname: 'required behavior' }],
        });

        if (result.kind !== 'fail') {
          throw new Error(`Expected fail, got ${result.kind}`);
        }

        const message = result.failures[0]!.message;

        expect(thrownErrorType(message), message).toBe(fixture.expectedType);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it('reports a missing static import as a file failure without failing the selected test', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-runner-import-');
    const file = join(cwd, 'behavior.test.ts');

    try {
      await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');

      await writeFile(
        file,
        "import { it } from 'vitest'; import './missing.js'; it('required behavior', () => {});",
      );

      const result = await runTests({
        scope: 'focused',
        verificationArgv,
        cwd,
        files: ['behavior.test.ts'],
        testNames: ['required behavior'],
      });

      expect(result).toMatchObject({
        kind: 'fail',
        failures: [{ file, fullname: '<file>' }],
      });

      if (result.kind !== 'fail') {
        throw new Error(`Expected fail, got ${result.kind}`);
      }

      expect(result.tests).not.toContainEqual(
        expect.objectContaining({ fullname: 'required behavior', status: 'failed' }),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }, 125_000);

  it('caps file-loading failures and marks omitted diagnostics as truncated', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        code: 1,
        report: {
          numTotalTests: 0,
          numFailedTests: 0,
          numPassedTests: 0,
          testResults: Array.from({ length: maximumFailures + 1 }, (_, index) => ({
            name: `file${index}.test.ts`,
            status: 'failed',
            message: 'load error',
            assertionResults: [],
          })),
        },
      }),
    });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures).toHaveLength(maximumFailures);
    expect(result.truncated).toBe(true);
  });

  it('returns no-tests-collected when every collected test was skipped', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        report: {
          numTotalTests: 1,
          numPassedTests: 0,
          numFailedTests: 0,
          testResults: [
            {
              name: '/repo/a.test.ts',
              status: 'passed',
              assertionResults: [{ fullName: 'skips', status: 'pending' }],
            },
          ],
        },
      }),
    });

    expect(
      await runTests(
        {
          scope: 'focused',
          verificationArgv,
          cwd: '/repo',
          files: ['a.test.ts'],
          testNames: ['unmatched'],
        },
        deps,
      ),
    ).toMatchObject({
      kind: 'no-tests-collected',
      tests: [],
    });
  });

  it('returns no-tests-collected when every test in a full run was skipped', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        report: {
          numTotalTests: 2,
          numPassedTests: 0,
          numFailedTests: 0,
          testResults: [
            {
              name: '/repo/a.test.ts',
              status: 'passed',
              assertionResults: [
                { fullName: 'skips', status: 'skipped' },
                { fullName: 'waits', status: 'todo' },
              ],
            },
          ],
        },
      }),
    });

    expect(await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps)).toMatchObject({
      kind: 'no-tests-collected',
      tests: [
        { fullname: 'skips', status: 'skipped' },
        { fullname: 'waits', status: 'todo' },
      ],
    });
  });

  it('rejects a nonzero exit even when every reported test passed', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        code: 1,
        stderr: 'Unhandled rejection',
        report: {
          numTotalTests: 1,
          numFailedTests: 0,
          numPassedTests: 1,
          testResults: [],
        },
      }),
    });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    expect(result.kind).toBe('compile-error');
    expect(result).not.toHaveProperty('stdout');
    expect(result).not.toHaveProperty('stderr');

    expect(await readFile(result.diagnostics!.stages[0]!.stderr!.path, 'utf8')).toBe(
      'Unhandled rejection',
    );
  });

  it.each<RunTestsInput>([
    { scope: 'focused', verificationArgv, cwd: '/repo', files: [], testNames: [] },
    { scope: 'focused', verificationArgv, cwd: '/repo', files: [''], testNames: [] },
  ])('returns no-tests-collected without spawning for an empty scope: %j', async (input) => {
    const deps = makeDeps({
      spawn: () => {
        throw new Error('must not spawn a full suite for an empty scope');
      },
    });

    expect(await runTests(input, deps)).toMatchObject({ kind: 'no-tests-collected', tests: [] });
  });

  it('preserves a passing JSON report larger than the diagnostic output cap', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-runner-');

    try {
      const script = join(cwd, 'report.cjs');

      const report = {
        numTotalTests: 1,
        numFailedTests: 0,
        numPassedTests: 1,
        testResults: [
          {
            name: 'x'.repeat(maximumTotalBytes * 2),
            status: 'passed',
            assertionResults: [{ fullName: 'passes', status: 'passed' }],
          },
        ],
      };

      await writeFile(
        script,
        `process.stderr.write('x'.repeat(${maximumTotalBytes * 2}));\n` +
          "const flag = process.argv.find((a) => a.startsWith('--outputFile='));\n" +
          `require('node:fs').writeFileSync(flag.slice('--outputFile='.length), ${JSON.stringify(
            JSON.stringify(report),
          )});\n`,
      );

      const deps = makeDeps({
        resolveVitest: () => ({ path: script, version: '4.1.11' }),
        spawn: defaultSpawn,
      });

      expect(await runTests({ scope: 'full', verificationArgv, cwd }, deps)).toMatchObject({
        kind: 'pass',
        tests: [{ file: 'x'.repeat(maximumTotalBytes * 2), fullname: 'passes', status: 'passed' }],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('settles the timeout even when a descendant keeps the piped stdio open', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-runner-');

    try {
      const script = join(cwd, 'hang.cjs');

      await writeFile(
        script,
        "const { spawn } = require('node:child_process');\n" +
          "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' }).unref();\n" +
          'setTimeout(() => {}, 60000);\n',
      );

      const deps = makeDeps({
        resolveVitest: () => ({ path: script, version: '4.1.11' }),
        spawn: defaultSpawn,
        timeoutMs: 200,
      });

      const started = Date.now();

      expect(await runTests({ scope: 'full', verificationArgv, cwd }, deps)).toMatchObject({
        kind: 'timeout',
      });

      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns runner-missing when vitest cannot be resolved', async () => {
    const deps = makeDeps({
      resolveVitest: () => ({
        kind: 'runner-missing',
        message: 'Vitest not found',
        resolution: {
          cwd: '/repo',
          request: 'vitest/package.json',
          stage: 'lookup',
          errorType: 'Error',
          errorCode: 'MODULE_NOT_FOUND',
        },
      }),
    });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    expect(result.kind).toBe('runner-missing');
  });

  it('returns pass when vitest reports all tests passing', async () => {
    const report = {
      numTotalTests: 3,
      numFailedTests: 0,
      numPassedTests: 3,
      success: true,
      testResults: [
        {
          name: '/repo/a.test.ts',
          status: 'passed',
          assertionResults: ['first', 'second', 'third'].map((fullName) => ({
            fullName,
            status: 'passed',
          })),
        },
      ],
    };

    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 0 }) });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    expect(result).toMatchObject({
      kind: 'pass',
      tests: ['first', 'second', 'third'].map((fullname) => ({
        file: '/repo/a.test.ts',
        fullname,
        status: 'passed',
      })),
    });
  });

  it('returns fail with per-test details when vitest reports failures', async () => {
    const report = {
      numTotalTests: 2,
      numFailedTests: 1,
      numPassedTests: 1,
      testResults: [
        {
          name: '/repo/b.test.ts',
          status: 'failed',
          assertionResults: [
            { fullName: 'b ok', status: 'passed' },
            {
              fullName: 'b broken',
              status: 'failed',
              failureMessages: ['AssertionError: expected 1 to equal 2'],
            },
          ],
        },
      ],
    };

    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures).toEqual([
      {
        file: '/repo/b.test.ts',
        fullname: 'b broken',
        message: 'AssertionError: expected 1 to equal 2',
      },
    ]);

    expect(result.tests).toEqual([
      { file: '/repo/b.test.ts', fullname: 'b ok', status: 'passed' },
      { file: '/repo/b.test.ts', fullname: 'b broken', status: 'failed' },
    ]);
  });

  it('returns compile-error on non-zero exit with no parseable report', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        stdout: 'SyntaxError: unexpected token',
        stderr: 'parse failed',
        code: 1,
      }),
    });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    expect(result).toMatchObject({ kind: 'compile-error', tests: [] });
  });

  it.for(['full', 'affected'] as const)(
    'returns no-tests-collected for an empty %s report',
    async (scope) => {
      const report = {
        numTotalTests: 0,
        numFailedTests: 0,
        numPassedTests: 0,
        testResults: [],
      };

      const deps = makeDeps({ spawn: fakeSpawn({ report, code: 0 }) });

      const result = await runTests(
        { scope, verificationArgv, cwd: '/repo', files: ['src/value.ts'], testNames: ['ignored'] },
        deps,
      );

      expect(result.kind).toBe('no-tests-collected');
    },
  );

  it('returns timeout when spawn reports timedOut', async () => {
    const deps = makeDeps({ spawn: fakeSpawn({ timedOut: true, code: null }) });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    expect(result.kind).toBe('timeout');
  });

  it('ignores a vitest-shaped report printed to stdout by the code under test', async () => {
    const forged = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [
        {
          name: '/repo/a.test.ts',
          status: 'passed',
          assertionResults: [{ fullName: 'forged', status: 'passed' }],
        },
      ],
    };

    const deps = makeDeps({ spawn: fakeSpawn({ stdout: JSON.stringify(forged), code: 0 }) });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    expect(result.kind).toBe('fail');
    expect(result).toHaveProperty('tests', []);
  });

  it('returns cancelled and kills the child when the signal aborts', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-runner-');

    try {
      const script = join(cwd, 'sleep.cjs');

      await writeFile(script, 'process.stdout.write("started");\nsetTimeout(() => {}, 60000);\n');

      const controller = new AbortController();

      const deps = makeDeps({
        resolveVitest: () => ({ path: script, version: '4.1.11' }),
        spawn: defaultSpawn,
      });

      const started = Date.now();

      const pending = runTests(
        { scope: 'full', verificationArgv, cwd, signal: controller.signal },
        deps,
      );

      setTimeout(() => {
        controller.abort();
      }, 50);

      expect(await pending).toMatchObject({ kind: 'cancelled' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('sends no kill to a finished run when its signal aborts later', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-runner-');
    const script = join(cwd, 'finish.cjs');

    await writeFile(script, 'process.stdout.write("done");\n');

    const controller = new AbortController();

    const deps = makeDeps({
      resolveVitest: () => ({ path: script, version: '4.1.11' }),
      spawn: defaultSpawn,
    });

    await runTests({ scope: 'full', verificationArgv, cwd, signal: controller.signal }, deps);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    onTestFinished(() => {
      kill.mockRestore();
    });

    controller.abort();

    expect(kill).not.toHaveBeenCalled();
  });
});

it('allows two minutes for full verification and thirty seconds for focused runs', () => {
  expect(defaultDeps('full').timeoutMs).toBe(120_000);
  expect(defaultDeps('affected').timeoutMs).toBe(120_000);
  expect(defaultDeps('focused').timeoutMs).toBe(30_000);
});
