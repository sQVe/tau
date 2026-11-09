import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';

import { configFileName } from '../../../config/config.js';
import type { TddConfig } from '../config.js';
import { cargoInputFiles } from './cargoInputFiles.js';
import { parseCargoMetadata } from './cargoMetadata.js';
import { runWithDiagnostics } from './diagnostics.js';
import type { StageSpawn } from './diagnostics.js';
import { parseJunitReport } from './junit.js';
import type { JunitReport } from './junit.js';
import {
  listArguments,
  manifestArguments,
  metadataArguments,
  runArguments,
  targetArguments,
  toolConfig,
} from './nextestArguments.js';
import { planFocus } from './nextestFocus.js';
import { parseNextestList } from './nextestList.js';
import { listOutcome, metadataOutcome, runOutcome } from './nextestResult.js';
import { buildBinarySources } from './nextestSources.js';
import { defaultSpawn } from './process.js';
import { executableOnPath } from './resolution.js';
import type { RustBinarySources } from './rustAttribution.js';
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

type StageOutcome =
  | { kind: 'stop'; report: RunnerResult; stages: StageSpawn[] }
  | {
      kind: 'continue';
      stages: StageSpawn[];
      binaries: RustBinarySources[];
      targets: string[];
    };

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

const configurationFiles = (
  { cargoManifestPath }: TddConfig,
  cwd: string,
  repositoryRoot: string,
): string[] => {
  const manifestPath =
    cargoManifestPath === undefined ? undefined : resolve(repositoryRoot, cargoManifestPath);

  return cargoInputFiles(manifestPath, cwd, repositoryRoot);
};

const maximumOutputExcerptLength = 500;

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

const isAborted = (input: RunTestsInput): boolean => input.signal?.aborted === true;

const stageInterruption = (
  input: RunTestsInput,
  deadline: number,
  stage: string,
): RunnerResult | undefined => {
  if (isAborted(input)) {
    return { kind: 'cancelled' };
  }

  return performance.now() >= deadline ? { kind: 'timeout', stage } : undefined;
};

const stageFacts = (input: RunTestsInput, result: SpawnResult, deadline: number) => ({
  code: result.code,
  timedOut: result.timedOut || performance.now() >= deadline,
  aborted: isAborted(input),
});

const spawnStage = async (
  name: string,
  argumentsList: string[],
  input: RunTestsInput,
  spawnRequest: { spawn: SpawnCommand; deadline: number; stdoutFile?: string },
): Promise<StageSpawn> => {
  const started = performance.now();

  const result = await spawnRequest.spawn('cargo', argumentsList, {
    cwd: input.cwd,
    timeoutMs: Math.max(0, spawnRequest.deadline - started),
    signal: input.signal,
    stdoutFile: spawnRequest.stdoutFile,
  });

  return { name, durationMs: Math.round(performance.now() - started), result };
};

const runStageArguments = (
  input: RunTestsInput,
  profileName: string,
  toolConfigPath: string,
  targets: readonly string[],
  binaryIds: string[] | undefined,
): string[] => {
  const request = { profileName, toolConfigPath, targets };

  if (input.scope === 'focused') {
    const focused = { ...request, testNames: input.testNames };

    return runArguments(binaryIds === undefined ? focused : { ...focused, binaryIds });
  }

  return runArguments(request);
};

const unreadableJson = (command: string, stdout: string): RunnerResult => {
  const excerpt = stdout.trim().slice(0, maximumOutputExcerptLength);
  const detail = excerpt === '' ? '' : `\n${excerpt}`;

  return {
    kind: 'compile-error',
    message: `cargo ${command} did not return readable JSON, so Tau found no test binaries.${detail}`,
    tests: [],
  };
};

const readFullStdout = async (path: string, result: SpawnResult): Promise<string | null> => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return result.stdoutTruncated ? null : result.stdout;
  }
};

const buildStages = async (
  input: RunTestsInput,
  request: { spawn: SpawnCommand; deadline: number; directory: string },
): Promise<StageOutcome> => {
  const metadataPath = join(request.directory, 'metadata.stdout.json');
  const manifest = manifestArguments(input.cargoManifestPath, input.cargoLocked === true);

  const metadata = await spawnStage('metadata', [...metadataArguments(), ...manifest], input, {
    spawn: request.spawn,
    deadline: request.deadline,
    stdoutFile: metadataPath,
  });

  const metadataReport = metadataOutcome({
    ...stageFacts(input, metadata.result, request.deadline),
    stderr: metadata.result.stderr,
  });

  if (metadataReport !== undefined) {
    return { kind: 'stop', report: metadataReport, stages: [metadata] };
  }

  const metadataStdout = await readFullStdout(metadataPath, metadata.result);
  const parsedMetadata = metadataStdout === null ? null : parseCargoMetadata(metadataStdout);

  if (parsedMetadata === null) {
    return {
      kind: 'stop',
      report: unreadableJson('metadata', metadata.result.stdout),
      stages: [metadata],
    };
  }

  const metadataInterruption = stageInterruption(input, request.deadline, 'metadata');

  if (metadataInterruption !== undefined) {
    return { kind: 'stop', report: metadataInterruption, stages: [metadata] };
  }

  // List and run must build the same package with the same lock file rules.
  const targets = [...targetArguments(parsedMetadata), ...manifest];
  const listPath = join(request.directory, 'list.stdout.json');

  const list = await spawnStage('list', listArguments(targets), input, {
    spawn: request.spawn,
    deadline: request.deadline,
    stdoutFile: listPath,
  });

  const listReport = listOutcome({
    ...stageFacts(input, list.result, request.deadline),
    stderr: list.result.stderr,
  });

  const stages = [metadata, list];

  if (listReport !== undefined) {
    return { kind: 'stop', report: listReport, stages };
  }

  const listStdout = await readFullStdout(listPath, list.result);
  const parsedList = listStdout === null ? null : parseNextestList(listStdout);

  if (parsedList === null) {
    return {
      kind: 'stop',
      report: unreadableJson('nextest list', list.result.stdout),
      stages,
    };
  }

  const binaries = await buildBinarySources(input.cwd, parsedMetadata, parsedList.binaries);

  return {
    kind: 'continue',
    stages,
    binaries,
    targets,
  };
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
    directory,
  };

  const built = await buildStages(input, request);

  if (built.kind === 'stop') {
    return { report: built.report, stages: built.stages };
  }

  const { stages, binaries, targets } = built;

  if (isAborted(input)) {
    return { report: { kind: 'cancelled' }, stages };
  }

  if (performance.now() >= request.deadline) {
    return { report: { kind: 'timeout', stage: 'list' }, stages };
  }

  const requestedFiles = input.scope === 'focused' ? input.files : [];

  const focus =
    input.scope === 'full' ? { kind: 'unscoped' as const } : planFocus(binaries, requestedFiles);

  if (focus.kind === 'collect-none') {
    return { report: { kind: 'no-tests-collected', tests: [] }, stages };
  }

  const profileName = `tau-${randomUUID()}`;
  const toolConfigPath = join(directory, 'tool-config.toml');

  await writeFile(toolConfigPath, toolConfig(profileName, reportPath), { mode: 0o600, flag: 'wx' });

  if (isAborted(input)) {
    return { report: { kind: 'cancelled' }, stages };
  }

  if (performance.now() >= request.deadline) {
    return { report: { kind: 'timeout', stage: 'list' }, stages };
  }

  const binaryIds = focus.kind === 'scoped' ? focus.binaryIds : undefined;

  const runArgumentsList = runStageArguments(
    input,
    profileName,
    toolConfigPath,
    targets,
    binaryIds,
  );

  const runSpawn = await spawnStage('run', runArgumentsList, input, request);
  const junitReport = await readJunitReport(reportPath);

  const report = runOutcome({
    ...stageFacts(input, runSpawn.result, request.deadline),
    report: junitReport,
    reportPath,
    binaries,
    requestedFiles,
  });

  return { report, stages: [...stages, runSpawn] };
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
  configurationFiles,
  testNameFormat,
  focusedTimeoutMs: focusedTimeoutMilliseconds,
  fullTimeoutMs: fullTimeoutMilliseconds,
  testFilesCanBeProduction: true,
  verificationArgvError,
  run: runTests,
} satisfies TestRunner;
