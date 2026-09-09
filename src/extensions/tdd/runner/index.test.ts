import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { runTests } from './index.js';
import type { RunTestsInput, RunnerDeps, SpawnFn, SpawnResult } from './types.js';
import { MAX_FAILURES, MAX_MESSAGE_CHARS, MAX_STDOUT_BYTES, MAX_TOTAL_BYTES } from './types.js';
import {
  defaultDeps,
  defaultSpawn,
  extractBinPath,
  nodeExecutable,
  runnerAvailable,
} from './vitest.js';

const outputFileFrom = (args: string[]) => {
  const flag = args.find((arg) => arg.startsWith('--outputFile='));
  if (flag == null) {
    throw new Error('vitest was spawned without an --outputFile flag');
  }
  return flag.slice('--outputFile='.length);
};

const fakeSpawn =
  ({ report, ...result }: Partial<SpawnResult> & { report?: unknown }): SpawnFn =>
  async (_cmd, args) => {
    if (report !== undefined) {
      await writeFile(outputFileFrom(args), JSON.stringify(report));
    }
    return {
      stdout: '',
      stderr: '',
      code: 0,
      timedOut: false,
      ...result,
    };
  };

const makeDeps = (overrides: Partial<RunnerDeps>): RunnerDeps => ({
  resolveVitest: () => '/fake/vitest.js',
  spawn: fakeSpawn({}),
  timeoutMs: 30_000,
  ...overrides,
});

describe('runTests', () => {
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
          testResults: Array.from({ length: MAX_FAILURES + 1 }, (_, i) => ({
            name: `file${i}.test.ts`,
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
    expect(result.failures).toHaveLength(MAX_FAILURES);
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
    expect(await runTests({ scope: 'all', cwd: '/repo', filter: 'unmatched' }, deps)).toEqual({
      kind: 'no-tests-collected',
      tests: [],
    });
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

    expect(await runTests(input, deps)).toEqual({ kind: 'no-tests-collected', tests: [] });
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
            name: 'x'.repeat(MAX_TOTAL_BYTES * 2),
            status: 'passed',
            assertionResults: [{ fullName: 'passes', status: 'passed' }],
          },
        ],
      };
      await writeFile(
        script,
        `process.stderr.write('x'.repeat(${MAX_TOTAL_BYTES * 2}));\n` +
          "const flag = process.argv.find((a) => a.startsWith('--outputFile='));\n" +
          `require('node:fs').writeFileSync(flag.slice('--outputFile='.length), ${JSON.stringify(
            JSON.stringify(report),
          )});\n`,
      );
      const deps = makeDeps({ resolveVitest: () => script, spawn: defaultSpawn });

      expect(await runTests({ scope: 'all', cwd }, deps)).toEqual({
        kind: 'pass',
        tests: [{ file: 'x'.repeat(MAX_TOTAL_BYTES * 2), fullname: 'passes', status: 'passed' }],
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('kills the child and names the limit when stdout exceeds the cap', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-runner-'));
    try {
      const script = join(cwd, 'flood.cjs');
      await writeFile(
        script,
        `process.stdout.write('x'.repeat(${MAX_STDOUT_BYTES + 1}));\n` +
          'setTimeout(() => {}, 60000);\n',
      );
      const deps = makeDeps({ resolveVitest: () => script, spawn: defaultSpawn });

      const result = await runTests({ scope: 'all', cwd }, deps);

      expect(result.kind).toBe('output-limit');
      expect(result).toHaveProperty('message', expect.stringContaining(String(MAX_STDOUT_BYTES)));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

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
      const deps = makeDeps({ resolveVitest: () => script, spawn: defaultSpawn, timeoutMs: 200 });

      const started = Date.now();
      expect(await runTests({ scope: 'all', cwd }, deps)).toEqual({ kind: 'timeout' });
      expect(Date.now() - started).toBeLessThan(5_000);
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

    expect(result).toEqual({
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
      const deps = makeDeps({ resolveVitest: () => script, spawn: defaultSpawn });

      const started = Date.now();
      const pending = runTests({ scope: 'all', cwd, signal: controller.signal }, deps);
      setTimeout(() => {
        controller.abort();
      }, 50);

      expect(await pending).toEqual({ kind: 'cancelled' });
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

    expect(result).toEqual({
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
              failureMessages: [`a${'é'.repeat(MAX_MESSAGE_CHARS)}`],
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

    expect(await runTests({ scope: 'changed', cwd: '/repo', files: ['', ' '] }, deps)).toEqual({
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
    const longMessage = 'x'.repeat(MAX_MESSAGE_CHARS * 2);
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
    expect(result.failures).toHaveLength(MAX_FAILURES);
    expect(result.truncated).toBe(true);
    for (const failure of result.failures) {
      expect(failure.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS + 1);
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

    expect(result).toEqual({
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

  it('emits only fixed args (run --reporter=json --no-color) plus scope-derived paths', async () => {
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

    expect(captured.slice(0, 3)).toEqual(['run', '--reporter=json', '--no-color']);
    expect(captured).toContain('src/a.test.ts');
    const disallowed = captured.filter(
      (a) =>
        a.startsWith('--') &&
        !['--reporter=json', '--no-color'].includes(a) &&
        !a.startsWith('--outputFile='),
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

describe('runnerAvailable', () => {
  it('reports absence only for a missing runner and stays available on other errors', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'tau-available-'));
    try {
      expect(runnerAvailable(cwd)).toBe(false);

      // A stat that fails with anything but ENOENT (here ENOTDIR) proves nothing about the
      // runner, so the gate must stay on.
      await writeFile(join(cwd, 'node_modules'), '');
      expect(runnerAvailable(cwd)).toBe(true);

      await rm(join(cwd, 'node_modules'));
      await symlink(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), 'dir');
      expect(runnerAvailable(cwd)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe('nodeExecutable', () => {
  it('keeps a node executable and falls back to node on PATH for a compiled agent', () => {
    expect(nodeExecutable('/usr/bin/node')).toBe('/usr/bin/node');
    expect(nodeExecutable('C:\\Program Files\\nodejs\\node.exe')).toBe(
      'C:\\Program Files\\nodejs\\node.exe',
    );
    expect(nodeExecutable('/usr/bin/pi')).toBe('node');
    expect(nodeExecutable('/opt/pi-coding-agent/pi')).toBe('node');
  });

  it('keeps a nonstandard node name when no node command resolves', () => {
    vi.stubEnv('PATH', '');
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });

    expect(nodeExecutable('/usr/bin/nodejs')).toBe('/usr/bin/nodejs');
  });
});
