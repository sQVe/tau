import { writeFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from '../config.js';
import { fakeSpawn, makeDeps, outputFileFrom, runTests } from '../fixtures/vitestRunner.js';

const verificationArgv = defaultTddConfig.verificationArgv;

describe('runTests', () => {
  beforeAll(() => {
    const agentDirectory = temporaryDirectory(afterAll, 'tau-runner-agent-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('drops empty changed-file entries instead of letting them match every file', async () => {
    const deps = makeDeps({
      spawn: () => {
        throw new Error('must not spawn a full suite for an empty scope');
      },
    });

    expect(
      await runTests(
        { scope: 'focused', verificationArgv, cwd: '/repo', files: ['', ' '], testNames: [] },
        deps,
      ),
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
      spawn: async (command, argumentsList) => {
        captured = argumentsList;
        await writeFile(outputFileFrom(argumentsList), JSON.stringify(report));

        return fakeSpawn({})(command, argumentsList, { cwd: '/repo', timeoutMs: 30_000 });
      },
    });

    await runTests(
      {
        scope: 'focused',
        verificationArgv,
        cwd: '/repo',
        files: ['-a.test.ts', 'src/b.test.ts'],
        testNames: [],
      },
      deps,
    );

    expect(captured).toContain('./-a.test.ts');
    expect(captured).toContain('src/b.test.ts');

    await runTests(
      { scope: 'focused', verificationArgv, cwd: '/repo', files: ['-a.test.ts'], testNames: [] },
      deps,
    );

    expect(captured).toContain('./-a.test.ts');
    expect(captured).not.toContain('-a.test.ts');
  });

  it('passes the changed files and an exact test name pattern to vitest', async () => {
    let captured: string[] = [];

    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }],
    };

    const deps = makeDeps({
      spawn: async (command, argumentsList) => {
        captured = argumentsList;
        await writeFile(outputFileFrom(argumentsList), JSON.stringify(report));

        return fakeSpawn({})(command, argumentsList, { cwd: '/repo', timeoutMs: 30_000 });
      },
    });

    await runTests(
      {
        scope: 'focused',
        verificationArgv,
        cwd: '/repo',
        files: ['src/a.test.ts', 'src/b.test.ts'],
        testNames: ['adds item'],
      },
      deps,
    );

    expect(captured).toContain('src/a.test.ts');
    expect(captured).toContain('src/b.test.ts');
    expect(captured).toContain('-t');
    expect(captured).toContain('^(?:adds item)$');
  });

  it('passes no options beyond the fixed reporter arguments and the output file', async () => {
    let captured: string[] = [];

    const report = {
      numTotalTests: 1,
      numFailedTests: 0,
      numPassedTests: 1,
      testResults: [{ name: '/repo/a.test.ts', status: 'passed', assertionResults: [] }],
    };

    const deps = makeDeps({
      spawn: async (command, argumentsList) => {
        captured = argumentsList;
        await writeFile(outputFileFrom(argumentsList), JSON.stringify(report));

        return fakeSpawn({})(command, argumentsList, { cwd: '/repo', timeoutMs: 30_000 });
      },
    });

    await runTests(
      { scope: 'focused', verificationArgv, cwd: '/repo', files: ['src/a.test.ts'], testNames: [] },
      deps,
    );

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
