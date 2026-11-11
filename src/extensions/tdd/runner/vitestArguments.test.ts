import { writeFile } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { temporaryDirectory } from '../../../../tests/temporaryDirectoryHarness.js';
import { defaultTddConfig } from '../config.js';
import { fakeSpawn, makeDeps, outputFileFrom, runTests } from '../fixtures/vitestRunner.js';
import type { SpawnCommand } from './types.js';

const verificationArgv = defaultTddConfig.verificationArgv;

const reportReporterArgument: unknown = expect.stringMatching(
  /^--reporter=\/.+\/vitestReportReporter\.ts$/,
);

const isTauArgument = (argument: string) =>
  argument.endsWith('/vitestReportReporter.ts') || argument.startsWith('--outputFile=');

describe('runTests', () => {
  beforeAll(() => {
    const agentDirectory = temporaryDirectory(afterAll, 'tau-runner-agent-');
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it.for(['focused', 'affected'] as const)(
    'rejects empty %s file selections without spawning',
    async (scope) => {
      const deps = makeDeps({
        spawn: () => {
          throw new Error('must not spawn a full suite for an empty scope');
        },
      });

      expect(
        await runTests(
          { scope, verificationArgv, cwd: '/repo', files: ['', ' '], testNames: [] },
          deps,
        ),
      ).toMatchObject({
        kind: 'no-tests-collected',
        tests: [],
      });
    },
  );

  it.for(['focused', 'affected'] as const)(
    'guards dash-leading %s paths from option parsing',
    async (scope) => {
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
          scope,
          verificationArgv,
          cwd: '/repo',
          files: ['-a.test.ts', 'src/b.test.ts'],
          testNames: [],
        },
        deps,
      );

      const pathArgument = scope === 'focused' ? '-a.test.ts' : './-a.test.ts';

      expect(captured).toContain(pathArgument);
      expect(captured).toContain('src/b.test.ts');

      await runTests(
        { scope, verificationArgv, cwd: '/repo', files: ['-a.test.ts'], testNames: [] },
        deps,
      );

      const runnerArgumentsStart = scope === 'focused' ? 4 : 1;

      expect(captured).toContain(pathArgument);
      expect(captured.slice(runnerArgumentsStart)).not.toContain('-a.test.ts');
    },
  );

  it.for([
    { name: 'a leading run command', command: ['vitest', 'run', '--no-color'] },
    { name: 'options without a command', command: ['vitest', '--no-color'] },
  ])('uses related selection with $name and preserves options', async ({ command }) => {
    const spawn = vi.fn<SpawnCommand>(fakeSpawn({}));

    await runTests(
      {
        scope: 'affected',
        verificationArgv: command,
        cwd: '/repo',
        files: ['src/value.ts', 'src/value.test.ts'],
        testNames: ['ignored'],
      },
      makeDeps({ spawn }),
    );

    const argumentsList = spawn.mock.calls[0]![1];

    expect(argumentsList.slice(1)).toEqual([
      'related',
      '--run',
      '--no-color',
      expect.stringMatching(/^--outputFile=/),
      'src/value.ts',
      'src/value.test.ts',
    ]);
  });

  it.for([
    { version: '1.6.1', focusedEntry: false, reporterArguments: [] },
    { version: '4.1.11', focusedEntry: true, reporterArguments: [reportReporterArgument] },
  ])(
    'selects the focused command for Vitest $version',
    async ({ version, focusedEntry, reporterArguments }) => {
      const spawn = vi.fn<SpawnCommand>(fakeSpawn({}));

      await runTests(
        {
          scope: 'focused',
          verificationArgv,
          cwd: '/repo',
          files: ['src/a.test.ts', '-b.test.ts'],
          testNames: ['adds (item)', 'removes item'],
        },
        makeDeps({
          resolveVitest: () => ({ path: '/fake/vitest.js', version }),
          spawn,
        }),
      );

      const options: unknown[] = [
        'run',
        '--reporter=json',
        '--reporter=default',
        '--no-color',
        ...reporterArguments,
        expect.stringMatching(/^--outputFile=/),
      ];

      const nameFilter = ['-t', '^(?:adds \\(item\\)|removes item)$'];
      const entry: unknown = expect.stringMatching(/\/vitestFocused\.ts$/);

      const expected = focusedEntry
        ? [entry, '/fake/vitest.js', '2', 'src/a.test.ts', '-b.test.ts', ...options, ...nameFilter]
        : ['/fake/vitest.js', ...options, 'src/a.test.ts', './-b.test.ts', ...nameFilter];

      expect(spawn).toHaveBeenCalledOnce();
      expect(spawn.mock.calls[0]![1]).toEqual(expected);
    },
  );

  it('adds the Tau report reporter when a reporter flag takes its name as the next argument', async () => {
    const spawn = vi.fn<SpawnCommand>(fakeSpawn({}));

    await runTests(
      {
        scope: 'full',
        verificationArgv: ['vitest', 'run', '--reporter', 'json'],
        cwd: '/repo',
      },
      makeDeps({ spawn }),
    );

    expect(spawn.mock.calls[0]![1].slice(1)).toEqual([
      'run',
      '--reporter',
      'json',
      expect.stringMatching(/^--reporter=\/.+\/vitestReportReporter\.ts$/),
      expect.stringMatching(/^--outputFile=/),
    ]);
  });

  it.for(['1.6.1', '4.0.2'])(
    'leaves the reporters unchanged for Vitest %s, which gives config reporter options to no CLI reporter',
    async (version) => {
      const spawn = vi.fn<SpawnCommand>(fakeSpawn({}));

      await runTests(
        { scope: 'full', verificationArgv, cwd: '/repo' },
        makeDeps({ resolveVitest: () => ({ path: '/fake/vitest.js', version }), spawn }),
      );

      expect(spawn.mock.calls[0]![1].slice(1)).toEqual([
        'run',
        '--reporter=json',
        '--reporter=default',
        '--no-color',
        expect.stringMatching(/^--outputFile=/),
      ]);
    },
  );

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

    expect(captured.slice(4, 9)).toEqual([
      'run',
      '--reporter=json',
      '--reporter=default',
      '--no-color',
      expect.stringMatching(/^--reporter=\/.+\/vitestReportReporter\.ts$/),
    ]);

    expect(captured).toContain('src/a.test.ts');

    const disallowed = captured.filter(
      (argument) =>
        argument.startsWith('--') &&
        !['--reporter=json', '--reporter=default', '--no-color'].includes(argument) &&
        !isTauArgument(argument),
    );

    expect(disallowed).toEqual([]);
  });
});
