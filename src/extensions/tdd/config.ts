import { statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { readTauConfig, requireKnownKey, warnUnknownKeys } from '../../config/config.js';
import type { ConfigFile, ConfigLocation, ConfigWarnings } from '../../config/config.js';
import type { KnownKeys } from '../../schema.js';
import { mergeConfigLayers } from './configLayers.js';
import type { ConfigLayer, MergedTddConfig } from './configLayers.js';
import { fileRoles } from './fileRoles.js';
import type { FileRoles } from './fileRoles.js';
import { createInputRules, unsupportedGlobReason } from './inputGlob.js';
import type { InputRules } from './inputGlob.js';
import type { RepositoryRoot } from './repositoryRoot.js';
import {
  defaultRunner,
  defaultRunnerName,
  findRunner,
  knownRunnerNames,
  runners,
} from './runner/runners.js';
import type { RunnerTable } from './runner/runners.js';

export type TddConfig = Static<typeof tddConfigSchema>;

interface ClassificationRules {
  test: InputRules;
  production: InputRules;
}

// The repository root is the Git checkout root, or the session directory outside a checkout.
export interface TddConfigLocation extends ConfigLocation {
  repositoryRoot?: RepositoryRoot;
}

export interface LoadedTddConfig extends MergedTddConfig {
  // A repository config file that was skipped because the project is not trusted.
  ignored: string | undefined;
}

const globs = Type.Array(Type.String({ minLength: 1 }));

const tddConfigSchema = Type.Object({
  runner: Type.String({ minLength: 1 }),
  productionGlobs: globs,
  testGlobs: globs,
  testSupportGlobs: globs,
  excludedGlobs: globs,
  verificationArgv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  cargoManifestPath: Type.Optional(Type.String({ minLength: 1 })),
  cargoLocked: Type.Optional(Type.Boolean()),
});

const knownTddKeys: KnownKeys = {
  runner: true,
  productionGlobs: true,
  testGlobs: true,
  testSupportGlobs: true,
  excludedGlobs: true,
  verificationArgv: true,
  cargoManifestPath: true,
  cargoLocked: true,
};

// Other top-level keys belong to other consumers, possibly from a newer Tau sharing the user file.
const configFileSchema = Type.Object({
  tdd: Type.Optional(Type.Partial(tddConfigSchema)),
});

const defaultSource = 'built-in default';

export const defaultTddConfig: TddConfig = defaultRunner.defaults;

const problem = (value: unknown): string => {
  const [error] = Value.Errors(configFileSchema, value);

  if (error === undefined) {
    return 'unknown problem';
  }

  if (error.instancePath === '') {
    return `the top level ${error.message}`;
  }

  return `${error.instancePath} ${error.message}`;
};

const globListNames = [
  'productionGlobs',
  'testGlobs',
  'testSupportGlobs',
  'excludedGlobs',
] as const;

const rejectUnsupportedGlobs = (source: string, values: Partial<TddConfig>) => {
  for (const name of globListNames) {
    for (const glob of values[name] ?? []) {
      const reason = unsupportedGlobReason(glob);

      if (reason !== null) {
        throw new Error(
          `Invalid TDD config ${source}: ${name} entry "${glob}" is not supported: ${reason}. Use literal segments, *, **, ?, comma brace groups, a leading ./, and numeric ranges such as {1..3} of at most 1000 values. Fix the file; Tau does not fall back to another config.`,
        );
      }
    }
  }
};

const tddLayer = (
  { source, value }: ConfigFile,
  ui: ConfigWarnings,
  runnerTable: RunnerTable,
): ConfigLayer => {
  requireKnownKey('tdd');

  if (!Value.Check(configFileSchema, value)) {
    throw new Error(
      `Invalid TDD config ${source}: ${problem(value)}. Expected {"tdd": {...}} with runner as a non-empty string, productionGlobs, testGlobs, testSupportGlobs, and excludedGlobs as string arrays, verificationArgv as an array of non-empty strings, cargoManifestPath as a non-empty string, and cargoLocked as a boolean. Fix the file; Tau does not fall back to another config.`,
    );
  }

  const values = value.tdd ?? {};

  warnUnknownKeys(ui, source, values, knownTddKeys, 'tdd');

  const runnerName = values.runner;

  if (runnerName !== undefined && findRunner(runnerName, runnerTable) === undefined) {
    throw new Error(
      `Invalid TDD config ${source}: runner "${runnerName}" is unknown. Known runners: ${knownRunnerNames(runnerTable).join(', ')}. Fix the file; Tau does not fall back to another config.`,
    );
  }

  rejectUnsupportedGlobs(source, values);

  return { source, values };
};

const validateVerificationArgv = (merged: MergedTddConfig, runnerTable: RunnerTable): void => {
  const runner = findRunner(merged.config.runner, runnerTable);

  if (runner === undefined) {
    throw new Error(
      `Invalid TDD config ${merged.sources.runner}: runner "${merged.config.runner}" is unknown. Known runners: ${knownRunnerNames(runnerTable).join(', ')}. Fix the file; Tau does not fall back to another config.`,
    );
  }

  const error = runner.verificationArgvError(merged.config.verificationArgv);

  if (error !== null) {
    throw new Error(
      `Invalid TDD config ${merged.sources.verificationArgv}: ${error} Fix the file; Tau does not fall back to another config.`,
    );
  }
};

const isFile = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isFile() === true;

const validateCargoOptions = (
  { config, sources }: MergedTddConfig,
  repositoryRoot: string,
): void => {
  const nextest = runners.nextest.name;

  if (config.cargoManifestPath !== undefined && config.runner !== nextest) {
    throw new Error(
      `Invalid TDD config ${sources.cargoManifestPath ?? defaultSource}: cargoManifestPath works only with the nextest runner, not "${config.runner}". Remove it or set runner to nextest. Fix the file; Tau does not fall back to another config.`,
    );
  }

  if (config.cargoLocked !== undefined && config.runner !== nextest) {
    throw new Error(
      `Invalid TDD config ${sources.cargoLocked ?? defaultSource}: cargoLocked works only with the nextest runner, not "${config.runner}". Remove it or set runner to nextest. Fix the file; Tau does not fall back to another config.`,
    );
  }

  const manifestPath = config.cargoManifestPath;

  if (manifestPath === undefined) {
    return;
  }

  const source = sources.cargoManifestPath ?? defaultSource;

  if (basename(manifestPath) !== 'Cargo.toml') {
    throw new Error(
      `Invalid TDD config ${source}: cargoManifestPath "${manifestPath}" must name a Cargo.toml file. Fix the file; Tau does not fall back to another config.`,
    );
  }

  const resolvedPath = resolve(repositoryRoot, manifestPath);

  if (!isFile(resolvedPath)) {
    throw new Error(
      `Invalid TDD config ${source}: cargoManifestPath "${manifestPath}" names no file; Tau looked for ${resolvedPath} from the repository root. Fix the file; Tau does not fall back to another config.`,
    );
  }
};

// Only the nextest runner reads files above the session directory, so a failed Git lookup stops
// only that runner.
const repositoryRootPath = ({ config }: MergedTddConfig, location: TddConfigLocation): string => {
  const root = location.repositoryRoot ?? { kind: 'root', path: location.cwd };

  if (root.kind === 'root') {
    return root.path;
  }

  if (config.runner === runners.nextest.name) {
    throw new Error(root.message);
  }

  return location.cwd;
};

export const loadTddConfig = (
  location: TddConfigLocation,
  ui: ConfigWarnings,
  runnerTable: RunnerTable,
  initialRunner = defaultRunnerName,
): LoadedTddConfig => {
  const { files, ignored } = readTauConfig(location);
  const layers = files.map((file) => tddLayer(file, ui, runnerTable));

  const merged = mergeConfigLayers(
    initialRunner,
    (name) => findRunner(name, runnerTable)?.defaults,
    defaultSource,
    layers,
  );

  validateVerificationArgv(merged, runnerTable);
  validateCargoOptions(merged, repositoryRootPath(merged, location));

  return { ...merged, ignored };
};

// Configs are not changed after loading, so the compiled rules stay valid for each config object.
const rulesByConfig = new WeakMap<TddConfig, ClassificationRules>();

const classificationRules = (config: TddConfig): ClassificationRules => {
  const cached = rulesByConfig.get(config);

  if (cached !== undefined) {
    return cached;
  }

  const rules = {
    test: createInputRules(config.testGlobs, config.excludedGlobs),
    production: createInputRules(config.productionGlobs, config.excludedGlobs),
  };

  rulesByConfig.set(config, rules);

  return rules;
};

export const classifyPath = (
  config: TddConfig,
  path: string,
  testFilesCanBeProduction: boolean,
): FileRoles => {
  const normalizedPath = path.replaceAll('\\', '/');
  const rules = classificationRules(config);

  return fileRoles({
    testMatch: rules.test.isInput(normalizedPath),
    productionMatch: rules.production.isInput(normalizedPath),
    testFilesCanBeProduction,
  });
};
