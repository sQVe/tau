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
  'productionGlobs',
  'testGlobs',
  'testSupportGlobs',
  'excludedGlobs',
  'verificationArgv',
];

// Later layers win per field. A list replaces the earlier one instead of extending it.
export const mergeConfigLayers = (
  defaults: TddConfig,
  defaultSource: string,
  layers: ConfigLayer[],
): MergedTddConfig => {
  const config = { ...defaults };

  const sources: Record<keyof TddConfig, string> = {
    productionGlobs: defaultSource,
    testGlobs: defaultSource,
    testSupportGlobs: defaultSource,
    excludedGlobs: defaultSource,
    verificationArgv: defaultSource,
  };

  for (const { source, values } of layers) {
    for (const key of tddConfigFields) {
      const value = values[key];

      if (value !== undefined) {
        config[key] = value;
        sources[key] = source;
      }
    }
  }

  return { config, sources };
};
