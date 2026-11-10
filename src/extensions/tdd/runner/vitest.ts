import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';

import { configFileName } from '../../../config/config.js';
import type { TddConfig } from '../config.js';
import { runWithDiagnostics } from './diagnostics.js';
import type { StageSpawn } from './diagnostics.js';
import { defaultSpawn } from './process.js';
import { classifyReport, parseReport, unparseableReportResult } from './report.js';
import type { VitestReport } from './report.js';
import {
  defaultResolveVitest,
  explainSessionCwd,
  nodeExecutable,
  resolutionFailure,
} from './resolution.js';
import type { ResolveVitest } from './resolution.js';
import type {
  RunTestsInput,
  RunnerResult,
  SpawnCommand,
  SpawnResult,
  TestRunner,
} from './types.js';

interface RunnerDeps {
  resolveVitest: ResolveVitest;
  spawn: SpawnCommand;
  timeoutMs: number;
}

const defaultTimeoutMilliseconds = 30_000;
const fullTimeoutMilliseconds = 120_000;

const testNameFormat = 'Vitest 4 joins nested names with spaces, Vitest 5 with " > "';

const vitestDefaults: TddConfig = {
  runner: 'vitest',
  productionGlobs: ['{src,apps,packages,functions,infra}/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  testGlobs: ['**/*.test.{ts,tsx,js,jsx,mjs,cjs}', '**/*.spec.{ts,tsx,js,jsx,mjs,cjs}'],
  testSupportGlobs: ['tests/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  excludedGlobs: [
    '**/{node_modules,.git,dist,build,coverage,.next,.nuxt,.output,.turbo,.cache,generated,__generated__}/**',
  ],
  verificationArgv: ['vitest', 'run', '--reporter=json', '--reporter=default', '--no-color'],
};

const configurationGlobs = [
  `${CONFIG_DIR_NAME}/${configFileName}`,
  '**/package.json',
  '**/{vite,vitest}.config.{ts,mts,cts,js,mjs,cjs}',
  '**/vitest.workspace.{ts,mts,cts,js,mjs,cjs,json}',
  '**/tsconfig*.json',
  '**/{pnpm-lock.yaml,package-lock.json,npm-shrinkwrap.json,yarn.lock,bun.lock,bun.lockb,pnpm-workspace.yaml}',
];

// The report is read from the reporter's own output file: stdout carries test-controlled
// text, so a report scraped from it could be forged by the code under test.
const readReport = async (path: string): Promise<VitestReport | null> => {
  try {
    return parseReport(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

// Vitest's CLI parses dash-leading positionals as options and treats an empty
// filter as "match every file", so neither may reach it as a scoped path.
const toFilterArgument = (path: string) => (path.startsWith('-') ? `./${path}` : path);

const scopedPaths = (input: RunTestsInput): string[] => {
  const paths = input.scope === 'full' ? [] : input.files;

  return paths.filter((path) => path.trim().length > 0);
};

const isAborted = (input: RunTestsInput): boolean => input.signal?.aborted === true;

const exactNamePattern = (testNames: readonly string[]) =>
  `^(?:${testNames.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;

const buildArguments = (input: RunTestsInput, outputFile: string): string[] | null => {
  const runnerArguments = input.verificationArgv.slice(1);

  if (input.scope === 'affected') {
    if (runnerArguments[0] === 'run') {
      runnerArguments.shift();
    }

    runnerArguments.unshift('related', '--run');
  }

  runnerArguments.push(`--outputFile=${outputFile}`);

  if (input.scope !== 'full') {
    const paths = scopedPaths(input);

    if (paths.length === 0) {
      return null;
    }

    runnerArguments.push(...paths.map(toFilterArgument));

    if (input.scope === 'focused') {
      runnerArguments.push('-t', exactNamePattern(input.testNames));
    }
  }

  return runnerArguments;
};

export const defaultDeps = (scope: RunTestsInput['scope'] = 'focused'): RunnerDeps => ({
  resolveVitest: defaultResolveVitest,
  spawn: defaultSpawn,
  timeoutMs: scope === 'focused' ? defaultTimeoutMilliseconds : fullTimeoutMilliseconds,
});

const classifyResult = async (
  input: RunTestsInput,
  result: SpawnResult,
  outputFile: string,
  version: string,
): Promise<RunnerResult> => {
  if (isAborted(input)) {
    return { kind: 'cancelled' };
  }

  if (result.timedOut) {
    return { kind: 'timeout' };
  }

  const report = await readReport(outputFile);

  if (isAborted(input)) {
    return { kind: 'cancelled' };
  }

  if (report == null) {
    return unparseableReportResult(input, result.code, result.stdout, result.stderr);
  }

  return classifyReport(input, result.code, report, version);
};

const runInDirectory = async (
  input: RunTestsInput,
  dependencies: RunnerDeps,
  outputFile: string,
): Promise<{ report: RunnerResult; stage?: StageSpawn }> => {
  const runnerArguments = buildArguments(input, outputFile);

  if (runnerArguments == null) {
    return { report: { kind: 'no-tests-collected', tests: [] } };
  }

  let runner: ReturnType<ResolveVitest>;

  try {
    runner = dependencies.resolveVitest(input.cwd);
  } catch (error) {
    runner = resolutionFailure(input.cwd, 'resolver', error);
  }

  if ('kind' in runner) {
    return { report: explainSessionCwd(runner, input.cwd, scopedPaths(input)) };
  }

  const spawnStarted = performance.now();

  const commandArguments = [runner.path, ...runnerArguments];

  if (input.scope === 'focused') {
    const entry = fileURLToPath(new URL('./vitestFocused.ts', import.meta.url));

    commandArguments.unshift(entry);
  }

  const result = await dependencies.spawn(nodeExecutable(), commandArguments, {
    cwd: input.cwd,
    timeoutMs: dependencies.timeoutMs,
    signal: input.signal,
  });

  const durationMs = Math.round(performance.now() - spawnStarted);

  return {
    report: await classifyResult(input, result, outputFile, runner.version),
    stage: { name: 'run', durationMs, result },
  };
};

export const runTests = async (
  input: RunTestsInput,
  dependencies: RunnerDeps = defaultDeps(input.scope),
): Promise<RunnerResult> =>
  runWithDiagnostics(
    { reportFileName: 'report.json', reportFormat: 'json', timeoutMs: dependencies.timeoutMs },
    async (_directory, reportPath) => {
      const { report, stage } = await runInDirectory(input, dependencies, reportPath);

      return { report, stages: stage === undefined ? [] : [stage] };
    },
  );

const verificationArgvError = (verificationArgv: readonly string[]): string | null =>
  verificationArgv[0] === 'vitest'
    ? null
    : 'verificationArgv must start with "vitest" for the vitest runner.';

export const vitestRunner = {
  name: 'vitest',
  defaults: vitestDefaults,
  configurationGlobs,
  configurationFiles: () => [],
  testNameFormat,
  focusedTimeoutMs: defaultTimeoutMilliseconds,
  fullTimeoutMs: fullTimeoutMilliseconds,
  testFilesCanBeProduction: false,
  verificationArgvError,
  run: runTests,
} satisfies TestRunner;
