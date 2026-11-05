import type { TddConfig } from './config.js';

export interface ConfigLayer {
  source: string;
  values: Partial<TddConfig>;
}

export interface MergedTddConfig {
  config: TddConfig;
  sources: Record<keyof TddConfig, string>;
}

export const tddConfigFields: (keyof TddConfig)[] = [
  'runner',
  'productionGlobs',
  'testGlobs',
  'testSupportGlobs',
  'excludedGlobs',
  'verificationArgv',
];

const sourcesFrom = (source: string): Record<keyof TddConfig, string> => ({
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

  const config = { ...initial };
  const sources = sourcesFrom(defaultSource);

  for (const { source, values } of layers) {
    const nextRunner = values.runner;

    if (nextRunner !== undefined && nextRunner !== config.runner) {
      const nextDefaults = defaultsFor(nextRunner);

      if (nextDefaults === undefined) {
        throw new Error(`Unknown TDD runner: ${nextRunner}`);
      }

      Object.assign(config, nextDefaults);

      for (const key of tddConfigFields) {
        sources[key] = defaultSource;
      }
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
