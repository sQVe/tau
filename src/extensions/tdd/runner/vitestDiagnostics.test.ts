import { chmod, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from '../config.js';
import { fakeSpawn, makeDeps, outputFileFrom, runTests } from '../fixtures/vitestRunner.js';
import { defaultSpawn, maximumStdoutBytes, maximumTotalBytes } from './process.js';
import { nodeExecutable } from './resolution.js';
import { runTests as runTestsWithDiagnostics } from './vitest.js';

const verificationArgv = defaultTddConfig.verificationArgv;

const reportLimit = 8 * 1024 * 1024;

describe('runTests', () => {
  beforeEach(async () => {
    const agentDirectory = temporaryDirectory(onTestFinished, 'tau-runner-agent-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

    onTestFinished(async () => {
      vi.unstubAllEnvs();
    });
  });

  // Root removes a directory whatever its permissions, so chmod cannot make the removal fail.
  it.skipIf(process.getuid?.() === 0)(
    'keeps the runner error when removing its diagnostics directory also fails',
    async () => {
      const root = join(process.env.PI_CODING_AGENT_DIR ?? '', 'test-runs');
      onTestFinished(() => chmod(root, 0o700));

      const run = runTestsWithDiagnostics(
        { scope: 'full', verificationArgv, cwd: '/repo' },
        makeDeps({
          spawn: async () => {
            await chmod(root, 0o500);

            throw new Error('spawn exploded');
          },
        }),
      );

      await expect(run).rejects.toThrow('spawn exploded');
      expect(await readdir(root)).toEqual([expect.stringMatching(/^run-/)]);
    },
  );

  it('removes its diagnostics directory when the runner throws', async () => {
    const root = join(process.env.PI_CODING_AGENT_DIR ?? '', 'test-runs');

    const run = runTestsWithDiagnostics(
      { scope: 'full', verificationArgv, cwd: '/repo' },
      makeDeps({
        spawn: () => {
          throw new Error('spawn exploded');
        },
      }),
    );

    await expect(run).rejects.toThrow('spawn exploded');
    expect(await readdir(root)).toEqual([]);
  });

  it('records a duration no longer than the run took', async () => {
    const started = performance.now();

    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: '/repo' },
      makeDeps({
        spawn: fakeSpawn({
          report: { numTotalTests: 1, numFailedTests: 0, numPassedTests: 1, testResults: [] },
        }),
      }),
    );

    const elapsed = performance.now() - started;

    expect(result.diagnostics?.durationMs).toBeLessThanOrEqual(Math.ceil(elapsed));
  });

  it('retains diagnostics for successful failed skipped and interrupted runs', async () => {
    const passingReport = {
      numTotalTests: 1,
      numFailedTests: 0,
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
      numFailedTests: 0,
      numPassedTests: 0,
      testResults: [
        { name: '/repo/value.test.ts', status: 'failed', message: '', assertionResults: [] },
      ],
    };

    const cases = [
      { kind: 'pass', report: passingReport, code: 0, timedOut: false },
      { kind: 'fail', report: failingReport, code: 1, timedOut: false },
      {
        kind: 'no-tests-collected',
        report: { numTotalTests: 0, numFailedTests: 0, numPassedTests: 0, testResults: [] },
        code: 0,
        timedOut: false,
      },
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
        { scope: 'full', verificationArgv, cwd: '/repo', signal: controller.signal },
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
      expect(diagnostics.stages[0]!.durationMs).toBeLessThanOrEqual(diagnostics.durationMs);

      expect(diagnostics.stages[0]!.command).toEqual(
        expect.arrayContaining(['/fake/vitest.js', 'run', '--reporter=json', '--reporter=default']),
      );

      expect(diagnostics).toMatchObject({ timeoutMs: 30_000 });

      expect(diagnostics.stages[0]).toMatchObject({
        exitCode: fixture.code,
        stdout: { bytes: 20, truncated: fixture.stdoutTruncated ?? false },
        stderr: { bytes: 14, truncated: false },
      });

      expect(await readFile(diagnostics.stages[0]!.stdout!.path, 'utf8')).toBe(
        'test console output\n',
      );

      expect(await readFile(diagnostics.stages[0]!.stderr!.path, 'utf8')).toBe('setup warning\n');

      const savedReport: unknown =
        diagnostics.report.file === undefined
          ? undefined
          : JSON.parse(await readFile(diagnostics.report.file.path, 'utf8'));

      expect(savedReport).toEqual(fixture.report);

      expect((await stat(diagnostics.directory)).mode & 0o777).toBe(0o700);
    }

    expect(directories.size).toBe(cases.length);
  });

  it('bounds saved logs and raw reports without truncating test evidence', async () => {
    const rawReport = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      padding: 'x'.repeat(reportLimit),
      testResults: [
        {
          name: '/repo/value.test.ts',
          status: 'passed',
          assertionResults: [{ fullName: 'works', status: 'passed' }],
        },
      ],
    };

    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: '/repo' },
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

    expect(diagnostics.stages[0]!.stdout).toMatchObject({
      savedBytes: maximumStdoutBytes,
      bytes: maximumStdoutBytes + 1,
      truncated: true,
    });

    expect(diagnostics.stages[0]!.stderr).toMatchObject({
      savedBytes: maximumTotalBytes,
      bytes: maximumTotalBytes + 1,
      truncated: true,
    });

    expect(diagnostics.report.file).toMatchObject({ savedBytes: reportLimit, truncated: true });
    expect((await stat(diagnostics.stages[0]!.stdout!.path)).size).toBe(maximumStdoutBytes);
    expect((await stat(diagnostics.stages[0]!.stderr!.path)).size).toBe(maximumTotalBytes);
    expect((await stat(diagnostics.report.file!.path)).size).toBe(reportLimit);
  });

  it('keeps the verdict and reports artifact write failures without overwriting files', async () => {
    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: '/repo' },
      makeDeps({
        spawn: async (command, argumentsList) => {
          const reportPath = outputFileFrom(argumentsList);

          await writeFile(
            reportPath,
            JSON.stringify({
              numTotalTests: 1,
              numFailedTests: 0,
              numPassedTests: 1,
              testResults: [],
            }),
          );

          await writeFile(join(reportPath, '..', 'stdout.txt'), 'keep this content');

          return fakeSpawn({ stdout: 'new output' })(command, argumentsList, {
            cwd: '/repo',
            timeoutMs: 30_000,
          });
        },
      }),
    );

    expect(result.kind).toBe('pass');
    expect(result.diagnostics?.error).toContain('Could not save all diagnostics');

    expect(await readFile(join(result.diagnostics!.directory, 'stdout.txt'), 'utf8')).toBe(
      'keep this content',
    );
  });

  it('preserves passing and failing verdicts when console output exceeds the capture limit', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-noisy-runner-');

    await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');

    for (const expected of [1, 2]) {
      await writeFile(
        join(cwd, 'noise.test.ts'),
        `import { it, expect } from 'vitest'; it('noisy test', () => { for (let index = 0; index < 100; index++) console.log('x'.repeat(100 * 1024)); expect(1).toBe(${expected}); });`,
      );

      const result = await runTests({ scope: 'full', verificationArgv, cwd });

      expect(result.kind).toBe(expected === 1 ? 'pass' : 'fail');
      expect(result.diagnostics?.stages[0]?.stdout?.truncated).toBe(true);

      expect(result.diagnostics?.stages[0]?.stdout?.savedBytes).toBeLessThanOrEqual(
        maximumStdoutBytes,
      );

      expect(result.diagnostics?.stages[0]?.command[0]).toBe(nodeExecutable());
      expect(result.diagnostics?.stages[0]?.command[1]).toContain('vitest');
    }
  }, 125_000);

  it('records a spawn error as an execution that did not start', async () => {
    const cwd = temporaryDirectory(onTestFinished, 'tau-unstarted-runner-');

    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: join(cwd, 'missing') },
      makeDeps({ spawn: defaultSpawn }),
    );

    expect(result.kind).toBe('compile-error');
    expect(result.diagnostics?.stages[0]?.started).toBe(false);
    expect(result.diagnostics?.stages[0]?.excerpt).toContain('ENOENT');
    expect(result.diagnostics?.stages[0]?.command[0]).toBe(nodeExecutable());
  });

  it('returns fail (never pass) when JSON parse fails on exit 0', async () => {
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: '{not valid json', code: 0 }) });

    const result = await runTests({ scope: 'full', verificationArgv, cwd: '/repo' }, deps);

    expect(result).toMatchObject({ kind: 'fail', tests: [], truncated: false });

    expect(await readFile(result.diagnostics!.stages[0]!.stdout!.path, 'utf8')).toBe(
      '{not valid json',
    );
  });

  it('returns fail and retains the report when a malformed report exits 0', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/a.test.ts', status: 'unknown', assertionResults: [] }],
    };

    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: '/repo' },
      makeDeps({ spawn: fakeSpawn({ report, code: 0 }) }),
    );

    expect(result).toMatchObject({ kind: 'fail', tests: [] });
    expect(result.diagnostics?.report.file).toBeDefined();

    const savedReport: unknown = JSON.parse(
      await readFile(result.diagnostics!.report.file!.path, 'utf8'),
    );

    expect(savedReport).toEqual(report);
    expect((await stat(result.diagnostics!.directory)).isDirectory()).toBe(true);
  });

  it('returns compile-error and retains the report when a malformed report exits nonzero', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/a.test.ts', status: 'unknown', assertionResults: [] }],
    };

    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: '/repo' },
      makeDeps({ spawn: fakeSpawn({ report, code: 1 }) }),
    );

    expect(result).toMatchObject({ kind: 'compile-error', tests: [] });
    expect(result.diagnostics?.report.file).toBeDefined();

    const savedReport: unknown = JSON.parse(
      await readFile(result.diagnostics!.report.file!.path, 'utf8'),
    );

    expect(savedReport).toEqual(report);
    expect((await stat(result.diagnostics!.directory)).isDirectory()).toBe(true);
  });

  it('records the injected spawn command without inventing an executable', async () => {
    const command = ['remote-node', '/remote/vitest.mjs', 'run'];

    const result = await runTests(
      { scope: 'full', verificationArgv, cwd: '/repo' },
      makeDeps({
        spawn: fakeSpawn({
          command,
          report: { numTotalTests: 1, numFailedTests: 0, numPassedTests: 1, testResults: [] },
        }),
      }),
    );

    expect(result.diagnostics?.stages[0]?.command).toEqual(command);
  });
});
