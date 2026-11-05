import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';

import { configFileName } from '../../../config/config.js';
import type { TddConfig } from '../config.js';
import { runWithDiagnostics } from './diagnostics.js';
import type { StageSpawn } from './diagnostics.js';
import { parseJunitReport } from './junit.js';
import type { JunitReport } from './junit.js';
import { listArguments, runArguments, toolConfig } from './nextestArguments.js';
import { listOutcome, runOutcome } from './nextestResult.js';
import { defaultSpawn } from './process.js';
import { executableOnPath } from './resolution.js';
import type {
  RunnerResolutionFailure,
  RunnerResult,
  RunTestsInput,
  SpawnCommand,
  SpawnResult,
  TestRunner,
} from './types.js';

export interface NextestDeps {
  spawn: SpawnCommand;
  searchPath: string;
  timeoutMs: number;
}

interface StagesOutcome {
  report: RunnerResult;
  stages: StageSpawn[];
}

const focusedTimeoutMilliseconds = 120_000;
const fullTimeoutMilliseconds = 300_000;

const executableName = 'cargo-nextest';

const testNameFormat = 'module paths such as "sub::tests::adds"';

const nextestDefaults: TddConfig = {
  runner: 'nextest',
  productionGlobs: ['**/src/**/*.rs'],
  testGlobs: ['**/src/**/*.rs', '**/tests/**/*.rs'],
  testSupportGlobs: [],
  excludedGlobs: ['**/{target,.git}/**'],
  verificationArgv: ['cargo', 'nextest', 'run'],
};

const configurationGlobs = [
  `${CONFIG_DIR_NAME}/${configFileName}`,
  '**/Cargo.toml',
  'Cargo.lock',
  '**/build.rs',
  '.cargo/config',
  '.cargo/config.toml',
  '.config/nextest.toml',
  'rust-toolchain',
  'rust-toolchain.toml',
];

export const defaultDeps = (scope: RunTestsInput['scope'] = 'focused'): NextestDeps => ({
  spawn: defaultSpawn,
  // oxlint-disable-next-line node/no-process-env -- cargo finds its nextest subcommand on the caller's PATH.
  searchPath: process.env.PATH ?? '',
  timeoutMs: scope === 'full' ? fullTimeoutMilliseconds : focusedTimeoutMilliseconds,
});

const runnerMissing = (searchPath: string): RunnerResolutionFailure => ({
  kind: 'runner-missing',
  message: [
    `${executableName} was not found on PATH. Install it with \`cargo install --locked cargo-nextest\`, or use the repository runner.`,
    'Bash tests do not update Tau observations.',
  ].join('\n'),
  resolution: { executable: executableName, searchedPath: searchPath },
});

const readJunitReport = async (path: string): Promise<JunitReport | null> => {
  try {
    return parseJunitReport(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

const stageFacts = (input: RunTestsInput, result: SpawnResult, deadline: number) => ({
  code: result.code,
  timedOut: result.timedOut || performance.now() >= deadline,
  aborted: input.signal?.aborted === true,
});

const spawnStage = async (
  name: string,
  argumentsList: string[],
  input: RunTestsInput,
  spawnRequest: { spawn: SpawnCommand; deadline: number },
): Promise<StageSpawn> => {
  const started = performance.now();

  const result = await spawnRequest.spawn('cargo', argumentsList, {
    cwd: input.cwd,
    timeoutMs: Math.max(0, spawnRequest.deadline - started),
    signal: input.signal,
  });

  return { name, durationMs: Math.round(performance.now() - started), result };
};

const runStageArguments = (
  input: RunTestsInput,
  profileName: string,
  toolConfigPath: string,
): string[] => {
  const request = { profileName, toolConfigPath };

  return runArguments(
    input.scope === 'focused' ? { ...request, testNames: input.testNames } : request,
  );
};

const runStages = async (
  input: RunTestsInput,
  dependencies: NextestDeps,
  directory: string,
  reportPath: string,
): Promise<StagesOutcome> => {
  const request = {
    spawn: dependencies.spawn,
    deadline: performance.now() + dependencies.timeoutMs,
  };

  const list = await spawnStage('list', listArguments(), input, request);

  const listReport = listOutcome({
    ...stageFacts(input, list.result, request.deadline),
    stderr: list.result.stderr,
  });

  if (listReport !== undefined) {
    return { report: listReport, stages: [list] };
  }

  // A per-run profile name cannot match a profile the repository's nextest config defines.
  const profileName = `tau-${randomUUID()}`;
  const toolConfigPath = join(directory, 'tool-config.toml');

  await writeFile(toolConfigPath, toolConfig(profileName, reportPath), { mode: 0o600, flag: 'wx' });

  if (input.signal?.aborted === true) {
    return { report: { kind: 'cancelled' }, stages: [list] };
  }

  if (performance.now() >= request.deadline) {
    return { report: { kind: 'timeout', stage: 'list' }, stages: [list] };
  }

  const runArgumentsList = runStageArguments(input, profileName, toolConfigPath);
  const runSpawn = await spawnStage('run', runArgumentsList, input, request);

  const junitReport = await readJunitReport(reportPath);

  const report = runOutcome({
    ...stageFacts(input, runSpawn.result, request.deadline),
    report: junitReport,
    reportPath,
  });

  return { report, stages: [list, runSpawn] };
};

const runInDirectory = async (
  input: RunTestsInput,
  dependencies: NextestDeps,
  directory: string,
  reportPath: string,
): Promise<StagesOutcome> => {
  if (input.scope === 'focused' && input.testNames.length === 0) {
    return { report: { kind: 'no-tests-collected', tests: [] }, stages: [] };
  }

  if (executableOnPath([executableName], dependencies.searchPath) === undefined) {
    return { report: runnerMissing(dependencies.searchPath), stages: [] };
  }

  return runStages(input, dependencies, directory, reportPath);
};

export const runTests = async (
  input: RunTestsInput,
  dependencies: NextestDeps = defaultDeps(input.scope),
): Promise<RunnerResult> =>
  runWithDiagnostics(
    { reportFileName: 'report.xml', reportFormat: 'junit', timeoutMs: dependencies.timeoutMs },
    (directory, reportPath) => runInDirectory(input, dependencies, directory, reportPath),
  );

const verificationArgvError = (verificationArgv: readonly string[]): string | null =>
  isDeepStrictEqual(verificationArgv, nextestDefaults.verificationArgv)
    ? null
    : 'verificationArgv must be ["cargo", "nextest", "run"] for the nextest runner; extra arguments are not supported yet.';

export const nextestRunner = {
  name: 'nextest',
  defaults: nextestDefaults,
  configurationGlobs,
  testNameFormat,
  focusedTimeoutMs: focusedTimeoutMilliseconds,
  fullTimeoutMs: fullTimeoutMilliseconds,
  testFilesCanBeProduction: true,
  verificationArgvError,
  run: runTests,
} satisfies TestRunner;
