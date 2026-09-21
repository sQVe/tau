import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { runTests as runTestsWithDiagnostics } from './index.js';
import type { RunTestsInput, RunnerDeps, SpawnFn, SpawnResult } from './types.js';
import {
  maximumFailures,
  maximumMessageCharacters,
  maximumReportBytes,
  maximumStdoutBytes,
  maximumTotalBytes,
} from './types.js';
import {
  defaultDeps,
  defaultResolveVitest,
  defaultSpawn,
  extractBinPath,
  nodeExecutable,
} from './vitest.js';

const runTests = async (...argumentsList: Parameters<typeof runTestsWithDiagnostics>) => {
  const result = await runTestsWithDiagnostics(...argumentsList);

  if (result.diagnostics !== undefined) {
    const directory = result.diagnostics.directory;

    onTestFinished(() => rm(directory, { recursive: true, force: true }));
  }

  return result;
};

const outputFileFrom = (argumentsList: string[]) => {
  const flag = argumentsList.find((argument) => argument.startsWith('--outputFile='));

  if (flag == null) {
    throw new Error('vitest was spawned without an --outputFile flag');
  }

  return flag.slice('--outputFile='.length);
};

const fakeSpawn =
  ({ report, ...result }: Partial<SpawnResult> & { report?: unknown }): SpawnFn =>
  async (command, argumentsList) => {
    if (report !== undefined) {
      await writeFile(outputFileFrom(argumentsList), JSON.stringify(report));
    }

    return {
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
      command: ['fake-runner', command, ...argumentsList],
      started: true,
      ...result,
    };
  };

const makeDeps = (overrides: Partial<RunnerDeps>): RunnerDeps => ({
  resolveVitest: () => ({ path: '/fake/vitest.js', version: '4.1.11' }),
  spawn: fakeSpawn({}),
  timeoutMs: 30_000,
  ...overrides,
});

describe('runTests', () => {
  beforeEach(async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), 'tau-runner-agent-'));
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
    onTestFinished(async () => {
      vi.unstubAllEnvs();

      await rm(agentDirectory, { recursive: true, force: true });
    });
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
      const spawn = vi.fn<SpawnFn>(
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
        { scope: 'changed', cwd: '/repo', files: ['value.test.ts'], filter },
        makeDeps({ resolveVitest: () => ({ path: '/fake/vitest.js', version }), spawn }),
      );

      expect(spawn).toHaveBeenCalledExactlyOnceWith(
        '/fake/vitest.js',
        expect.arrayContaining(['-t', filter]),
        expect.objectContaining({ cwd: '/repo' }),
      );
      expect(result).toMatchObject({
        kind: 'fail',
        failures: [{ fullname, message: 'expected 1 to be 2' }],
      });
      // V4 cannot distinguish a top-level name containing spaces from the same nested name.
      expect('tests' in result && result.tests).toEqual([
        { file: '/repo/value.test.ts', fullname, status: 'failed' },
        ...(version.startsWith('4.')
          ? [{ file: '/repo/value.test.ts', fullname, status: 'skipped' }]
          : []),
      ]);
    },
  );

  it.for(['4.1.11', '5.0.1'])(
    'explains unmatched Vitest %s names without retrying or broadening selection',
    async (version) => {
      const filter = '^wrong nested name$';
      const spawn = vi.fn<SpawnFn>(
        fakeSpawn({
          report: {
            numTotalTests: 1,
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
        { scope: 'changed', cwd: '/repo', files: ['value.test.ts'], filter },
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
      expect(spawn.mock.calls[0]?.[1]).toContain(filter);
    },
  );

  it('resolves the name format version from the same package as the Vitest binary', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-vitest-version-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const directory = join(cwd, 'node_modules/vitest');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        name: 'vitest',
        version: '5.0.0-beta.1',
        bin: { vitest: './bin/vitest.mjs' },
      }),
    );

    await mkdir(join(directory, 'bin'));
    await writeFile(join(directory, 'bin/vitest.mjs'), '');

    expect(defaultResolveVitest(cwd)).toEqual({
      path: join(directory, 'bin/vitest.mjs'),
      version: '5.0.0-beta.1',
    });
  });

  it('reads the current Vitest version after a same-path package upgrade', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-vitest-upgrade-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const directory = join(cwd, 'node_modules/vitest');
    await mkdir(directory, { recursive: true });

    await writeFile(join(directory, 'vitest.mjs'), '');

    for (const version of ['4.1.11', '5.0.1']) {
      await writeFile(
        join(directory, 'package.json'),
        JSON.stringify({ name: 'vitest', version, bin: './vitest.mjs' }),
      );

      expect(defaultResolveVitest(cwd)).toEqual({
        path: join(directory, 'vitest.mjs'),
        version,
      });
    }
  });

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
      { scope: 'all', cwd: '/repo' },
      makeDeps({
        resolveVitest: () => ({ path: '/fake/vitest.js', version: '5.0.1' }),
        spawn: fakeSpawn({
          code: 1,
          report: {
            numTotalTests: 6,
            numFailedTests: 4,
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

  it('selects only an exact nested test with the installed Vitest runner', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-nested-selection-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
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
      scope: 'changed',
      cwd,
      files: ['nested.test.ts'],
      filter: '^outer suite inner \\[group\\] works \\(exact\\)$',
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
      scope: 'changed',
      cwd,
      files: ['nested.test.ts'],
      filter: '^outer suite > inner \\[group\\] > works \\(exact\\)$',
    });

    expect(unmatched).toMatchObject({ kind: 'no-tests-collected', tests: [] });
    expect(unmatched).toHaveProperty(
      'message',
      expect.stringContaining('outer suite inner [group] works (exact)'),
    );
  });

  it('retains diagnostics for successful failed skipped and interrupted runs', async () => {
    const passingReport = {
      numTotalTests: 1,
      numPassedTests: 1,
      testResults: [
        {
          name: '/repo/value.test.ts',
          status: 'passed',
          assertionResults: [{ fullName: 'value works', status: 'passed' }],
        },
      ],
    };
    const failingReport = {
      numTotalTests: 0,
      testResults: [
        { name: '/repo/value.test.ts', status: 'failed', message: '', assertionResults: [] },
      ],
    };
    const cases = [
      { kind: 'pass', report: passingReport, code: 0, timedOut: false },
      { kind: 'fail', report: failingReport, code: 1, timedOut: false },
      { kind: 'no-tests-collected', report: { numTotalTests: 0 }, code: 0, timedOut: false },
      { kind: 'compile-error', report: undefined, code: 1, timedOut: false },
      { kind: 'timeout', report: undefined, code: null, timedOut: true },
      { kind: 'cancelled', report: undefined, code: null, timedOut: false },
      {
        kind: 'pass',
        report: passingReport,
        code: 0,
        timedOut: false,
        stdoutTruncated: true,
      },
    ];
    const directories = new Set<string>();

    for (const fixture of cases) {
      const controller = new AbortController();
      const spawn = fakeSpawn({
        ...fixture,
        stdout: 'test console output\n',
        stderr: 'setup warning\n',
      });
      const result = await runTests(
        { scope: 'all', cwd: '/repo', signal: controller.signal },
        makeDeps({
          spawn: async (...argumentsList) => {
            const spawned = await spawn(...argumentsList);

            if (fixture.kind === 'cancelled') {
              controller.abort();
            }

            return spawned;
          },
        }),
      );

      expect(result.kind).toBe(fixture.kind);
      expect(result).toHaveProperty('diagnostics.directory');
      const diagnostics = result.diagnostics!;
      directories.add(diagnostics.directory);

      expect(diagnostics.durationMs).toBeGreaterThanOrEqual(0);
      expect(diagnostics.command).toEqual(
        expect.arrayContaining(['/fake/vitest.js', 'run', '--reporter=json', '--reporter=default']),
      );
      expect(diagnostics).toMatchObject({
        timeoutMs: 30_000,
        exitCode: fixture.code,
        stdout: { bytes: 20, truncated: fixture.stdoutTruncated ?? false },
        stderr: { bytes: 14, truncated: false },
      });
      expect(await readFile(diagnostics.stdout!.path, 'utf8')).toBe('test console output\n');
      expect(await readFile(diagnostics.stderr!.path, 'utf8')).toBe('setup warning\n');

      const savedReport: unknown =
        diagnostics.report === undefined
          ? undefined
          : JSON.parse(await readFile(diagnostics.report.path, 'utf8'));

      expect(savedReport).toEqual(fixture.report);
      expect(
        process.platform === 'win32' ||
          ((await stat(diagnostics.directory)).mode & 0o777) === 0o700,
      ).toBe(true);
    }

    expect(directories.size).toBe(cases.length);
  });

  it('bounds saved logs and raw reports without truncating test evidence', async () => {
    const rawReport = {
      numTotalTests: 1,
      numPassedTests: 1,
      padding: 'x'.repeat(maximumReportBytes),
      testResults: [
        {
          name: '/repo/value.test.ts',
          status: 'passed',
          assertionResults: [{ fullName: 'works', status: 'passed' }],
        },
      ],
    };
    const result = await runTests(
      { scope: 'all', cwd: '/repo' },
      makeDeps({
        spawn: fakeSpawn({
          report: rawReport,
          stdout: 'o'.repeat(maximumStdoutBytes + 1),
          stderr: 'e'.repeat(maximumTotalBytes + 1),
        }),
      }),
    );
    const diagnostics = result.diagnostics!;

    expect(result).toMatchObject({
      kind: 'pass',
      tests: [{ fullname: 'works', status: 'passed' }],
    });
    expect(diagnostics.stdout).toMatchObject({
      savedBytes: maximumStdoutBytes,
      bytes: maximumStdoutBytes + 1,
      truncated: true,
    });
    expect(diagnostics.stderr).toMatchObject({
      savedBytes: maximumTotalBytes,
      bytes: maximumTotalBytes + 1,
      truncated: true,
    });
    expect(diagnostics.report).toMatchObject({ savedBytes: maximumReportBytes, truncated: true });
    expect((await stat(diagnostics.stdout!.path)).size).toBe(maximumStdoutBytes);
    expect((await stat(diagnostics.stderr!.path)).size).toBe(maximumTotalBytes);
    expect((await stat(diagnostics.report!.path)).size).toBe(maximumReportBytes);
  });

  it('keeps the verdict and reports artifact write failures without overwriting files', async () => {
    const result = await runTests(
      { scope: 'all', cwd: '/repo' },
      makeDeps({
        spawn: async (_command, argumentsList) => {
          const reportPath = outputFileFrom(argumentsList);

          await writeFile(reportPath, JSON.stringify({ numTotalTests: 1, numPassedTests: 1 }));
          await writeFile(join(reportPath, '..', 'stdout.txt'), 'keep this content');

          return { stdout: 'new output', stderr: '', code: 0, timedOut: false };
        },
      }),
    );

    expect(result.kind).toBe('pass');
    expect(result.diagnostics?.error).toContain('Could not save all diagnostics');
    expect(await readFile(join(result.diagnostics!.directory, 'stdout.txt'), 'utf8')).toBe(
      'keep this content',
    );
  });

  it('returns every test identity and status from a real four-status fixture', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-runner-'));
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

      const result = await runTests({ scope: 'all', cwd });

      expect(result.kind).toBe('fail');
      expect(result).toHaveProperty('tests', [
        { file, fullname: 'suite passes', status: 'passed' },
        { file, fullname: 'suite fails', status: 'failed' },
        { file, fullname: 'suite skips', status: 'skipped' },
        { file, fullname: 'suite later', status: 'todo' },
      ]);
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
          testResults: Array.from({ length: maximumFailures + 1 }, (_, index) => ({
            name: `file${index}.test.ts`,
            status: 'failed',
            message: 'load error',
            assertionResults: [],
          })),
        },
      }),
    });
    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

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

    expect(await runTests({ scope: 'all', cwd: '/repo', filter: 'unmatched' }, deps)).toMatchObject(
      {
        kind: 'no-tests-collected',
        tests: [],
      },
    );
  });

  it('rejects a nonzero exit even when every reported test passed', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        code: 1,
        stderr: 'Unhandled rejection',
        report: { numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 },
      }),
    });
    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('compile-error');
    expect(result).toHaveProperty('stderr', 'Unhandled rejection');
  });

  it.each<RunTestsInput>([
    { scope: 'changed', cwd: '/repo' },
    { scope: 'changed', cwd: '/repo', files: [] },
    { scope: 'file', cwd: '/repo' },
    { scope: 'file', cwd: '/repo', path: '' },
  ])('returns no-tests-collected without spawning for an empty scope: %j', async (input) => {
    const deps = makeDeps({
      spawn: () => {
        throw new Error('must not spawn a full suite for an empty scope');
      },
    });

    expect(await runTests(input, deps)).toMatchObject({ kind: 'no-tests-collected', tests: [] });
  });

  it('preserves a passing JSON report larger than the diagnostic output cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-runner-'));

    try {
      const script = join(cwd, 'report.cjs');
      const report = {
        numTotalTests: 1,
        numFailedTests: 0,
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

      expect(await runTests({ scope: 'all', cwd }, deps)).toMatchObject({
        kind: 'pass',
        tests: [{ file: 'x'.repeat(maximumTotalBytes * 2), fullname: 'passes', status: 'passed' }],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('preserves passing and failing verdicts when console output exceeds the capture limit', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-noisy-runner-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));

    await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');

    for (const expected of [1, 2]) {
      await writeFile(
        join(cwd, 'noise.test.ts'),
        `import { it, expect } from 'vitest'; it('noisy test', () => { for (let index = 0; index < 100; index++) console.log('x'.repeat(100 * 1024)); expect(1).toBe(${expected}); });`,
      );
      const result = await runTests({ scope: 'all', cwd });

      expect(result.kind).toBe(expected === 1 ? 'pass' : 'fail');
      expect(result.diagnostics?.stdout?.truncated).toBe(true);
      expect(result.diagnostics?.stdout?.savedBytes).toBeLessThanOrEqual(maximumStdoutBytes);
      expect(result.diagnostics?.command?.[0]).toBe(nodeExecutable());
      expect(result.diagnostics?.command?.[1]).toContain('vitest');
    }
  }, 125_000);

  it('settles the timeout even when a descendant keeps the piped stdio open', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-runner-'));

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

      expect(await runTests({ scope: 'all', cwd }, deps)).toMatchObject({ kind: 'timeout' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('records a spawn error as an execution that did not start', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-unstarted-runner-'));
    onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    const result = await runTests(
      { scope: 'all', cwd: join(cwd, 'missing') },
      makeDeps({ spawn: defaultSpawn }),
    );

    expect(result.kind).toBe('compile-error');
    expect(result.diagnostics?.started).toBe(false);
    expect(result.diagnostics?.excerpt).toContain('ENOENT');
    expect(result.diagnostics?.command?.[0]).toBe(nodeExecutable());
  });

  it('records the injected spawn command without inventing an executable', async () => {
    const command = ['remote-node', '/remote/vitest.mjs', 'run'];
    const result = await runTests(
      { scope: 'all', cwd: '/repo' },
      makeDeps({ spawn: fakeSpawn({ command, report: { numTotalTests: 1, numPassedTests: 1 } }) }),
    );

    expect(result.diagnostics?.command).toEqual(command);
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

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

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

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

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

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

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

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('compile-error');
  });

  it('returns no-tests-collected when the report has zero tests and zero files', async () => {
    const report = { numTotalTests: 0, numFailedTests: 0, testResults: [] };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 0 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('no-tests-collected');
  });

  it('surfaces a file-level failure entry when vitest marks a file failed with no assertions', async () => {
    const report = {
      numTotalTests: 0,
      numFailedTests: 0,
      testResults: [
        {
          name: '/repo/broken.test.ts',
          status: 'failed',
          message: 'ReferenceError: foo is not defined',
          assertionResults: [],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures).toEqual([
      {
        file: '/repo/broken.test.ts',
        fullname: '<file>',
        message: 'ReferenceError: foo is not defined',
      },
    ]);
  });

  it('returns no-tests-collected when numTotalTests is 0 even if testResults lists empty files', async () => {
    const report = {
      numTotalTests: 0,
      numFailedTests: 0,
      testResults: [{ name: '/repo/empty.test.ts', status: 'passed', assertionResults: [] }],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 0 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('no-tests-collected');
  });

  it('returns timeout when spawn reports timedOut', async () => {
    const deps = makeDeps({ spawn: fakeSpawn({ timedOut: true, code: null }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

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

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('fail');
    expect(result).toHaveProperty('tests', []);
  });

  it('returns cancelled and kills the child when the signal aborts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-runner-'));

    try {
      const script = join(cwd, 'sleep.cjs');

      await writeFile(script, 'process.stdout.write("started");\nsetTimeout(() => {}, 60000);\n');

      const controller = new AbortController();

      const deps = makeDeps({
        resolveVitest: () => ({ path: script, version: '4.1.11' }),
        spawn: defaultSpawn,
      });

      const started = Date.now();
      const pending = runTests({ scope: 'all', cwd, signal: controller.signal }, deps);
      setTimeout(() => {
        controller.abort();
      }, 50);

      expect(await pending).toMatchObject({ kind: 'cancelled' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns fail (never pass) when JSON parse fails on exit 0', async () => {
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: '{not valid json', code: 0 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('fail');
  });

  it('reports a file-level hook error even when every assertion passed', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [
        {
          name: '/repo/hook.test.ts',
          status: 'failed',
          message: 'teardown boom',
          assertionResults: [{ fullName: 'passes', status: 'passed' }],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result).toMatchObject({
      kind: 'fail',
      failures: [{ file: '/repo/hook.test.ts', fullname: '<file>', message: 'teardown boom' }],
      tests: [{ file: '/repo/hook.test.ts', fullname: 'passes', status: 'passed' }],
      truncated: false,
    });
  });

  it('reports a file-level hook error alongside a failing assertion in the same file', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/mixed.test.ts',
          status: 'failed',
          message: 'teardown boom',
          assertionResults: [
            { fullName: 'fails', status: 'failed', failureMessages: ['expected 1 to be 2'] },
          ],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error('expected fail');
    }

    expect(result.failures.map((failure) => failure.message)).toEqual([
      'teardown boom',
      'expected 1 to be 2',
    ]);
  });

  it('keeps a multi-byte character whole when truncating a failure message', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'case',
              status: 'failed',
              failureMessages: [`a${'é'.repeat(maximumMessageCharacters)}`],
            },
          ],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error('expected fail');
    }

    expect(result.failures[0]?.message).not.toContain('\uFFFD');
    expect(result.failures[0]?.message.endsWith('é…')).toBe(true);
  });

  it('drops empty changed-file entries instead of letting them match every file', async () => {
    const deps = makeDeps({
      spawn: () => {
        throw new Error('must not spawn a full suite for an empty scope');
      },
    });

    expect(
      await runTests({ scope: 'changed', cwd: '/repo', files: ['', ' '] }, deps),
    ).toMatchObject({
      kind: 'no-tests-collected',
      tests: [],
    });
  });

  it('prefixes dash-leading scoped paths so vitest reads them as filters, not options', async () => {
    let captured: string[] = [];
    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/-a.test.ts', status: 'passed', assertionResults: [] }],
    };
    const deps = makeDeps({
      spawn: async (_cmd, args) => {
        captured = args;
        await writeFile(outputFileFrom(args), JSON.stringify(report));

        return { stdout: '', stderr: '', code: 0, timedOut: false };
      },
    });

    await runTests(
      { scope: 'changed', cwd: '/repo', files: ['-a.test.ts', 'src/b.test.ts'] },
      deps,
    );

    expect(captured).toContain('./-a.test.ts');
    expect(captured).toContain('src/b.test.ts');

    await runTests({ scope: 'file', cwd: '/repo', path: '-a.test.ts' }, deps);

    expect(captured).toContain('./-a.test.ts');
    expect(captured).not.toContain('-a.test.ts');
  });

  it('caps failures to 10 entries and truncates each assertion message to 300 characters', async () => {
    const longMessage = 'x'.repeat(maximumMessageCharacters * 2);

    const assertionResults = Array.from({ length: 15 }, (_, index) => ({
      fullName: `case ${index}`,
      status: 'failed',
      failureMessages: [longMessage],
    }));
    const report = {
      numTotalTests: 15,
      numFailedTests: 15,
      testResults: [{ name: '/repo/big.test.ts', status: 'failed', assertionResults }],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error('expected fail');
    }

    expect(result.tests).toEqual(
      assertionResults.map((assertion) => ({
        file: '/repo/big.test.ts',
        fullname: assertion.fullName,
        status: 'failed',
      })),
    );
    expect(result.failures).toHaveLength(maximumFailures);
    expect(result.truncated).toBe(true);

    for (const failure of result.failures) {
      expect(failure.message.length).toBeLessThanOrEqual(maximumMessageCharacters + 1);
    }
  });

  it('keeps only the tests the filter selected, including a selected skip', async () => {
    const report = {
      numTotalTests: 3,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [
        {
          name: '/repo/a.test.ts',
          status: 'passed',
          assertionResults: [
            { fullName: 'selected', status: 'passed' },
            { fullName: 'also selected', status: 'pending' },
            { fullName: 'unselected', status: 'pending' },
          ],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 0 }) });

    const result = await runTests(
      {
        scope: 'changed',
        cwd: '/repo',
        files: ['a.test.ts'],
        filter: '^(selected|also selected)$',
      },
      deps,
    );

    expect(result).toMatchObject({
      kind: 'pass',
      tests: [
        { file: '/repo/a.test.ts', fullname: 'selected', status: 'passed' },
        { file: '/repo/a.test.ts', fullname: 'also selected', status: 'skipped' },
      ],
    });
  });

  it('reduces a failure message to its assertion line and worktree frame', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/src/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'a broken',
              status: 'failed',
              failureMessages: [
                [
                  'AssertionError: expected 1 to be 2',
                  '',
                  '- Expected',
                  '+ Received',
                  '    at /repo/node_modules/vitest/dist/chunks/runner.js:12:9',
                  '    at Object.handler (/repo/src/a.test.ts:3:15)',
                ].join('\n'),
              ],
            },
          ],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures).toEqual([
      {
        file: '/repo/src/a.test.ts',
        fullname: 'a broken',
        message: 'AssertionError: expected 1 to be 2 (src/a.test.ts:3)',
      },
    ]);
  });

  it('falls back to the worktree frame when the message carries no assertion', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/src/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'times out',
              status: 'failed',
              failureMessages: [
                'Error: STACK_TRACE_ERROR\n    at Object.handler (/repo/src/a.test.ts:9:1)',
              ],
            },
          ],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures[0]?.message).toBe('src/a.test.ts:9');
  });

  it('reduces a file-level load error to its first line and worktree frame', async () => {
    const report = {
      numTotalTests: 0,
      numFailedTests: 0,
      testResults: [
        {
          name: '/repo/src/a.test.ts',
          status: 'failed',
          message: [
            'Error: Cannot find module ./missing',
            '    at /repo/node_modules/vite/dist/node/chunks/dep.js:4:1',
            '    at loadFile (/repo/src/a.test.ts:1:1)',
          ].join('\n'),
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures[0]?.message).toBe(
      'Error: Cannot find module ./missing (src/a.test.ts:1)',
    );
  });

  it('reduces unparseable runner output to its first line', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        code: 0,
        stderr: 'Error: vitest exploded\n    at /repo/node_modules/vitest/dist/cli.js:1:1',
      }),
    });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures[0]?.message).toBe('unparseable vitest output: Error: vitest exploded');
  });

  it('locates worktree frames regardless of a trailing separator on the worktree path', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/src/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'a broken',
              status: 'failed',
              failureMessages: [
                'AssertionError: expected 1 to be 2\n    at Object.handler (/repo/src/a.test.ts:3:15)',
              ],
            },
          ],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo/' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures[0]?.message).toBe(
      'AssertionError: expected 1 to be 2 (src/a.test.ts:3)',
    );
  });

  it('keeps frames outside the worktree out of the message', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/repo/src/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              fullName: 'a broken',
              status: 'failed',
              failureMessages: [
                'Error: STACK_TRACE_ERROR\n    at Object.handler (/repo-sibling/src/a.test.ts:3:15)',
              ],
            },
          ],
        },
      ],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ report, code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error(`expected fail, got ${result.kind}`);
    }

    expect(result.failures[0]?.message).toBe('');
  });

  it('passes the changed files list and filter through to vitest', async () => {
    let captured: string[] = [];
    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }],
    };
    const deps = makeDeps({
      spawn: async (_cmd, args) => {
        captured = args;
        await writeFile(outputFileFrom(args), JSON.stringify(report));

        return { stdout: '', stderr: '', code: 0, timedOut: false };
      },
    });

    await runTests(
      {
        scope: 'changed',
        cwd: '/repo',
        files: ['src/a.test.ts', 'src/b.test.ts'],
        filter: 'adds item',
      },
      deps,
    );

    expect(captured).toContain('src/a.test.ts');
    expect(captured).toContain('src/b.test.ts');
    expect(captured).toContain('-t');
    expect(captured).toContain('adds item');
  });

  it('passes only fixed reporter arguments plus scoped paths', async () => {
    let captured: string[] = [];
    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }],
    };
    const deps = makeDeps({
      spawn: async (_cmd, args) => {
        captured = args;
        await writeFile(outputFileFrom(args), JSON.stringify(report));

        return { stdout: '', stderr: '', code: 0, timedOut: false };
      },
    });

    await runTests({ scope: 'file', cwd: '/repo', path: 'src/a.test.ts' }, deps);

    expect(captured.slice(0, 4)).toEqual([
      'run',
      '--reporter=json',
      '--reporter=default',
      '--no-color',
    ]);
    expect(captured).toContain('src/a.test.ts');

    const disallowed = captured.filter(
      (argument) =>
        argument.startsWith('--') &&
        !['--reporter=json', '--reporter=default', '--no-color'].includes(argument) &&
        !argument.startsWith('--outputFile='),
    );

    expect(disallowed).toEqual([]);
  });
});

describe('extractBinPath', () => {
  it('resolves string, object-keyed, and missing bin entries', () => {
    expect(extractBinPath({ bin: './bin/vitest.mjs' })).toBe('./bin/vitest.mjs');
    expect(extractBinPath({ bin: { vitest: './dist/cli.js', other: './o.js' } })).toBe(
      './dist/cli.js',
    );
    expect(extractBinPath({ bin: { other: './o.js' } })).toBeNull();
    expect(extractBinPath({})).toBeNull();
    expect(extractBinPath(null)).toBeNull();
  });
});

it('allows two minutes for full verification and thirty seconds for focused runs', () => {
  expect(defaultDeps('all').timeoutMs).toBe(120_000);
  expect(defaultDeps('changed').timeoutMs).toBe(30_000);
  expect(defaultDeps('file').timeoutMs).toBe(30_000);
});

describe('nodeExecutable', () => {
  it('ignores a directory named node on PATH', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tau-node-'));
    onTestFinished(async () => {
      vi.unstubAllEnvs();

      await rm(directory, { recursive: true, force: true });
    });

    await mkdir(join(directory, process.platform === 'win32' ? 'node.exe' : 'node'));
    vi.stubEnv('PATH', directory);

    expect(nodeExecutable('/usr/bin/nodejs')).toBe('/usr/bin/nodejs');
  });

  it.each(process.platform === 'win32' ? ['node'] : ['node', 'nodejs'])(
    'finds %s on PATH for a compiled agent',
    async (name) => {
      const directory = await mkdtemp(join(tmpdir(), 'tau-node-'));
      onTestFinished(async () => {
        vi.unstubAllEnvs();

        await rm(directory, { recursive: true, force: true });
      });

      const executable = join(directory, process.platform === 'win32' ? `${name}.exe` : name);

      await writeFile(executable, '');
      await chmod(executable, 0o755);

      vi.stubEnv('PATH', directory);

      expect(nodeExecutable('/usr/bin/pi')).toBe(executable);
      expect(nodeExecutable('/opt/pi-coding-agent/pi')).toBe(executable);
    },
  );

  it('keeps a node executable regardless of PATH', () => {
    expect(nodeExecutable('/usr/bin/node')).toBe('/usr/bin/node');
    expect(nodeExecutable('C:\\Program Files\\nodejs\\node.exe')).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    );
  });

  it('keeps a nonstandard node name when no node command resolves', () => {
    vi.stubEnv('PATH', '');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    expect(nodeExecutable('/usr/bin/nodejs')).toBe('/usr/bin/nodejs');
  });
});
