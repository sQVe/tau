import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, matchesGlob, relative, resolve } from 'node:path';

import { Instrumenter } from '@stryker-mutator/instrumenter';
import { noopLogger } from '@stryker-mutator/util';

import { enabledIgnorers } from './mutationIgnorePolicy.ts';
import { mutationIgnorer } from './mutationIgnorer.ts';
import { buildMutationReport, failedMutationReport } from './mutationReport.ts';
import type { MutationMode, MutationOutcome, StrykerReport } from './mutationReport.ts';
import {
  auditScope,
  changedLinesDiffArguments,
  changedScope,
  countedMutants,
  fitCap,
  isProductionFile,
  mergedConfig,
  mutateConfigError,
  mutatePatterns,
  parseCommand,
  rejectedAuditPaths,
  unreportedFiles,
} from './mutationScope.ts';
import type { Command, FileScope } from './mutationScope.ts';

interface StrykerConfig {
  mutate?: string[];
  thresholds?: Record<string, unknown>;
  mutator?: { excludedMutations?: string[] };
  ignorers?: string[];
  [key: string]: unknown;
}

const maxGitOutput = Number.POSITIVE_INFINITY;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: maxGitOutput });

const parseConfig = (path: string): StrykerConfig => {
  // SAFETY: the file is a Stryker config; only the fields in StrykerConfig are read here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the config is user JSON.
  return JSON.parse(readFileSync(path, 'utf8')) as StrykerConfig;
};

const readConfig = (path: string): StrykerConfig => {
  const config = parseConfig(path);

  const problem = mutateConfigError(config.mutate, path);

  if (problem !== undefined) {
    throw new Error(problem);
  }

  return config;
};

const changedFiles = (root: string, base: string, isProduction: (path: string) => boolean) => {
  const diff = git(root, ...changedLinesDiffArguments(base));
  const untrackedOutput = git(root, 'ls-files', '-z', '--others', '--exclude-standard');
  const untracked = untrackedOutput.split('\0').filter((path) => path !== '');

  return changedScope(diff, untracked, isProduction);
};

const auditFiles = (root: string, paths: string[], isProduction: (path: string) => boolean) => {
  const relativePaths = paths.map((path) => relative(root, resolve(path)));
  const rejected = rejectedAuditPaths(relativePaths, isProduction);

  if (rejected.length > 0) {
    throw new Error(`Not production code in the config's mutate globs: ${rejected.join(', ')}`);
  }

  return auditScope(relativePaths, isProduction);
};

const wholeFileRanges = (scope: FileScope) =>
  scope.ranges === undefined
    ? true
    : scope.ranges.map(({ start, end }) => ({
        start: { line: start - 1, column: 0 },
        end: { line: end - 1, column: Number.MAX_SAFE_INTEGER },
      }));

const countMutants = async (root: string, scope: FileScope, config: StrykerConfig) => {
  const instrumenter = new Instrumenter(noopLogger);
  const ignorers = enabledIgnorers(config.ignorers, mutationIgnorer);
  const content = readFileSync(join(root, scope.path), 'utf8');

  const result = await instrumenter.instrument(
    [{ name: scope.path, content, mutate: wholeFileRanges(scope) }],
    { plugins: null, excludedMutations: config.mutator?.excludedMutations ?? [], ignorers },
  );

  return countedMutants(result.mutants);
};

const runStryker = (
  root: string,
  config: StrykerConfig,
  scopes: FileScope[],
  mode: MutationMode,
): StrykerReport => {
  const directory = mkdtempSync(join(tmpdir(), 'mutation-'));

  try {
    const reportPath = join(directory, 'mutation.json');
    const configPath = join(directory, 'stryker.config.json');

    const merged = mergedConfig(config, scopes.flatMap(mutatePatterns), reportPath, mode);

    writeFileSync(configPath, JSON.stringify(merged, undefined, 2));

    const stryker = spawnSync(join(root, 'node_modules/.bin/stryker'), ['run', configPath], {
      cwd: root,
      stdio: ['ignore', 2, 2],
    });

    if (stryker.status !== 0) {
      throw new Error(`Stryker exited with status ${stryker.status}. See its output on stderr.`);
    }

    // SAFETY: Stryker's JSON reporter writes this shape; the report builder reads only these fields.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the report is Stryker output.
    return JSON.parse(readFileSync(reportPath, 'utf8')) as StrykerReport;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const readSources = (root: string, report: StrykerReport) =>
  Object.fromEntries(
    Object.keys(report.files).map((path) => [path, readFileSync(join(root, path), 'utf8')]),
  );

const mutate = async (command: Command): Promise<{ report: MutationOutcome; exitCode: number }> => {
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  const config = readConfig(resolve(root, command.configPath ?? 'stryker.config.json'));
  const mutateGlobs = config.mutate ?? [];
  const isProduction = (path: string) => isProductionFile(path, mutateGlobs, matchesGlob);

  const scopes =
    command.mode === 'changed'
      ? changedFiles(root, command.base ?? 'HEAD', isProduction)
      : auditFiles(root, command.paths, isProduction);

  const counts = await Promise.all(
    scopes.map(async (scope) => ({
      path: scope.path,
      mutants: await countMutants(root, scope, config),
    })),
  );

  const { run, unmutated } = fitCap(counts, command.maxMutants);
  const runScopes = scopes.filter(({ path }) => run.includes(path));

  const stryker =
    runScopes.length === 0 ? undefined : runStryker(root, config, runScopes, command.mode);

  const sources = stryker === undefined ? {} : readSources(root, stryker);

  const reportedPaths = Object.entries(stryker?.files ?? {})
    .filter(([, { mutants }]) => mutants.length > 0)
    .map(([path]) => path);

  const unreported = unreportedFiles(
    counts.filter(({ path }) => run.includes(path)),
    reportedPaths,
  );

  return buildMutationReport({
    mode: command.mode,
    ...(stryker === undefined ? {} : { stryker }),
    sources,
    unmutated: [...unmutated, ...unreported].toSorted(),
  });
};

const main = async () => {
  let result: { report: MutationOutcome; exitCode: number };
  let mode: MutationMode | null = null;

  try {
    const command = parseCommand(process.argv.slice(2));

    mode = command.mode;
    result = await mutate(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    result = { report: failedMutationReport(mode, message), exitCode: 1 };
  }

  process.stdout.write(`${JSON.stringify(result.report, undefined, 2)}\n`);
  process.exitCode = result.exitCode;
};

await main();
