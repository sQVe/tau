import type { TddConfig } from './config.js';

export interface ConfigLayer {
  source: string;
  values: Partial<TddConfig>;
}

export type TddConfigSources = { [Key in keyof TddConfig]: string };

export interface MergedTddConfig {
  config: TddConfig;
  sources: TddConfigSources;
}

export const tddConfigFields: (keyof TddConfig)[] = [
  'runner',
  'productionGlobs',
  'testGlobs',
  'testSupportGlobs',
  'excludedGlobs',
  'verificationArgv',
  'cargoManifestPath',
  'cargoLocked',
];

const sourcesFrom = (source: string): TddConfigSources => ({
  runner: source,
  productionGlobs: source,
  testGlobs: source,
  testSupportGlobs: source,
  excludedGlobs: source,
  verificationArgv: source,
});

export const mergeConfigLayers = (
  defaultRunner: string,
  defaultsFor: (runnerName: string) => TddConfig | undefined,
  defaultSource: string,
  layers: ConfigLayer[],
): MergedTddConfig => {
  const initial = defaultsFor(defaultRunner);

  if (initial === undefined) {
    throw new Error(`Unknown TDD runner: ${defaultRunner}`);
  }

  let config = { ...initial };
  let sources = sourcesFrom(defaultSource);

  for (const { source, values } of layers) {
    const nextRunner = values.runner;

    if (nextRunner !== undefined && nextRunner !== config.runner) {
      const nextDefaults = defaultsFor(nextRunner);

      if (nextDefaults === undefined) {
        throw new Error(`Unknown TDD runner: ${nextRunner}`);
      }

      config = { ...nextDefaults };
      sources = sourcesFrom(defaultSource);
    }

    for (const key of tddConfigFields) {
      const value = values[key];

      if (value !== undefined) {
        Object.assign(config, { [key]: value });
        sources[key] = source;
      }
    }
  }

  return { config, sources };
};
