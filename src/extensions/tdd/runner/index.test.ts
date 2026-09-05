import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runTests } from './index.js';
import type { RunTestsInput, RunnerDeps, SpawnFn, SpawnResult } from './types.js';
import { MAX_ASSERTION_BYTES, MAX_FAILURES, MAX_TOTAL_BYTES } from './types.js';
import { defaultSpawn, extractBinPath } from './vitest.js';

const fakeSpawn =
  (result: Partial<SpawnResult>): SpawnFn =>
  () =>
    Promise.resolve({
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
      ...result,
    });

const makeDeps = (overrides: Partial<RunnerDeps>): RunnerDeps => ({
  resolveVitest: () => '/fake/vitest.js',
  spawn: fakeSpawn({}),
  timeoutMs: 30_000,
  ...overrides,
});

describe('runTests', () => {
  it('caps file-loading failures and marks omitted diagnostics as truncated', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        code: 1,
        stdout: JSON.stringify({
          numTotalTests: 0,
          numFailedTests: 0,
          testResults: Array.from({ length: MAX_FAILURES + 1 }, (_, i) => ({
            name: `file${i}.test.ts`,
            status: 'failed',
            message: 'load error',
            assertionResults: [],
          })),
        }),
      }),
    });
    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);
    if (result.kind !== 'fail') throw new Error(`expected fail, got ${result.kind}`);
    expect(result.failures).toHaveLength(MAX_FAILURES);
    expect(result.truncated).toBe(true);
  });

  it('returns no-tests-collected when every collected test was skipped', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        stdout: JSON.stringify({
          numTotalTests: 1,
          numPassedTests: 0,
          numFailedTests: 0,
          testResults: [{ status: 'passed', assertionResults: [{ status: 'pending' }] }],
        }),
      }),
    });
    expect(await runTests({ scope: 'all', cwd: '/repo', filter: 'unmatched' }, deps)).toEqual({
      kind: 'no-tests-collected',
    });
  });

  it('rejects a nonzero exit even when every reported test passed', async () => {
    const deps = makeDeps({
      spawn: fakeSpawn({
        code: 1,
        stderr: 'Unhandled rejection',
        stdout: JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0 }),
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

    expect(await runTests(input, deps)).toEqual({ kind: 'no-tests-collected' });
  });

  it('preserves a passing JSON report larger than the diagnostic output cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-runner-'));
    try {
      const script = join(cwd, 'report.cjs');
      const report = {
        numTotalTests: 1,
        numFailedTests: 0,
        testResults: [{ name: 'x'.repeat(MAX_TOTAL_BYTES * 2), status: 'passed' }],
      };
      await writeFile(
        script,
        `process.stderr.write('x'.repeat(${MAX_TOTAL_BYTES * 2}));\n` +
          `process.stdout.write(${JSON.stringify(JSON.stringify(report))});\n`,
      );
      const deps = makeDeps({ resolveVitest: () => script, spawn: defaultSpawn });

      expect(await runTests({ scope: 'all', cwd }, deps)).toEqual({ kind: 'pass', total: 1 });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('returns runner-missing when vitest cannot be resolved', async () => {
    const deps = makeDeps({ resolveVitest: () => null });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('runner-missing');
  });

  it('returns pass when vitest reports all tests passing', async () => {
    const report = {
      numTotalTests: 3,
      numFailedTests: 0,
      numPassedTests: 3,
      success: true,
      testResults: [{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: JSON.stringify(report), code: 0 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result).toEqual({ kind: 'pass', total: 3 });
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
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: JSON.stringify(report), code: 1 }) });

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
    expect(result.failed).toBe(1);
    expect(result.total).toBe(2);
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
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: JSON.stringify(report), code: 0 }) });

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
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: JSON.stringify(report), code: 1 }) });

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
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: JSON.stringify(report), code: 0 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('no-tests-collected');
  });

  it('returns timeout when spawn reports timedOut', async () => {
    const deps = makeDeps({ spawn: fakeSpawn({ timedOut: true, code: null }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('timeout');
  });

  it('tolerates non-JSON preamble and parses the first {-at-column-0 payload', async () => {
    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }],
    };
    const stdout = `stderr-like preamble\nRUN v1.0\n${JSON.stringify(report)}\n`;
    const deps = makeDeps({ spawn: fakeSpawn({ stdout, code: 0 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('pass');
  });

  it('returns fail (never pass) when JSON parse fails on exit 0', async () => {
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: '{not valid json', code: 0 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    expect(result.kind).toBe('fail');
  });

  it('caps failures to 10 entries and truncates each assertion message to 2KB', async () => {
    const longMessage = 'x'.repeat(MAX_ASSERTION_BYTES * 2);
    const assertionResults = Array.from({ length: 15 }, (_, i) => ({
      fullName: `case ${i}`,
      status: 'failed',
      failureMessages: [longMessage],
    }));
    const report = {
      numTotalTests: 15,
      numFailedTests: 15,
      testResults: [{ name: '/repo/big.test.ts', status: 'failed', assertionResults }],
    };
    const deps = makeDeps({ spawn: fakeSpawn({ stdout: JSON.stringify(report), code: 1 }) });

    const result = await runTests({ scope: 'all', cwd: '/repo' }, deps);

    if (result.kind !== 'fail') {
      throw new Error('expected fail');
    }
    expect(result.failures).toHaveLength(MAX_FAILURES);
    expect(result.truncated).toBe(true);
    for (const failure of result.failures) {
      expect(Buffer.byteLength(failure.message, 'utf8')).toBeLessThanOrEqual(
        MAX_ASSERTION_BYTES + 4,
      );
    }
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
      spawn: (_cmd, args) => {
        captured = args;
        return Promise.resolve({
          stdout: JSON.stringify(report),
          stderr: '',
          code: 0,
          timedOut: false,
        });
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

  it('emits only fixed args (run --reporter=json --no-color) plus scope-derived paths', async () => {
    let captured: string[] = [];
    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }],
    };
    const deps = makeDeps({
      spawn: (_cmd, args) => {
        captured = args;
        return Promise.resolve({
          stdout: JSON.stringify(report),
          stderr: '',
          code: 0,
          timedOut: false,
        });
      },
    });

    await runTests({ scope: 'file', cwd: '/repo', path: 'src/a.test.ts' }, deps);

    expect(captured.slice(0, 3)).toEqual(['run', '--reporter=json', '--no-color']);
    expect(captured).toContain('src/a.test.ts');
    const disallowed = captured.filter(
      (a) => a.startsWith('--') && !['--reporter=json', '--no-color'].includes(a),
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
