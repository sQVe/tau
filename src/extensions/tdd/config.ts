import { matchesGlob } from 'node:path';

import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { configFileName, readTauConfig } from '../../tauConfig/index.js';
import type { ConfigFile, ConfigLocation } from '../../tauConfig/index.js';
import { mergeConfigLayers } from './configLayers.js';
import type { ConfigLayer, MergedTddConfig } from './configLayers.js';

export type TddConfig = Static<typeof tddConfigSchema>;

export interface LoadedTddConfig extends MergedTddConfig {
  // A repository config file that was skipped because the project is not trusted.
  ignored: string | undefined;
}

const globs = Type.Array(Type.String({ minLength: 1 }));

const tddConfigSchema = Type.Object(
  {
    productionGlobs: globs,
    testGlobs: globs,
    testSupportGlobs: globs,
    excludedGlobs: globs,
    verificationArgv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);

// Other top-level keys belong to other consumers, possibly from a newer Tau sharing the user file.
const configFileSchema = Type.Object({
  tdd: Type.Optional(Type.Partial(tddConfigSchema, { additionalProperties: false })),
});

const defaultSource = 'built-in default';

export const defaultTddConfig: TddConfig = {
  productionGlobs: ['{src,apps,packages,functions,infra}/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  testGlobs: ['**/*.test.{ts,tsx,js,jsx,mjs,cjs}', '**/*.spec.{ts,tsx,js,jsx,mjs,cjs}'],
  testSupportGlobs: ['tests/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
  excludedGlobs: [
    '**/{node_modules,.git,dist,build,coverage,.next,.nuxt,.output,.turbo,.cache,generated,__generated__}/**',
  ],
  // The default reporter keeps console and setup diagnostics; JSON alone omits them.
  verificationArgv: ['vitest', 'run', '--reporter=json', '--reporter=default', '--no-color'],
};

// Vitest loads its own configuration before Vite's. Hash both because either can change which tests run.
export const configurationGlobs = [
  `${CONFIG_DIR_NAME}/${configFileName}`,
  '**/package.json',
  '**/{vite,vitest}.config.{ts,mts,cts,js,mjs,cjs}',
  '**/vitest.workspace.{ts,mts,cts,js,mjs,cjs,json}',
  '**/tsconfig*.json',
  '**/{pnpm-lock.yaml,package-lock.json,npm-shrinkwrap.json,yarn.lock,bun.lock,bun.lockb,pnpm-workspace.yaml}',
];

const problem = (value: unknown): string => {
  const [error] = Value.Errors(configFileSchema, value);

  if (error === undefined) {
    return 'unknown problem';
  }

  if (error.instancePath === '') {
    return `the top level ${error.message}`;
  }

  // Unknown keys fail as a `false` schema for that key.
  return error.keyword === 'boolean'
    ? `${error.instancePath} is not a known key`
    : `${error.instancePath} ${error.message}`;
};

const tddLayer = ({ source, value }: ConfigFile): ConfigLayer => {
  if (!Value.Check(configFileSchema, value)) {
    throw new Error(
      `Invalid TDD config ${source}: ${problem(value)}. Expected {"tdd": {...}} with productionGlobs, testGlobs, testSupportGlobs, and excludedGlobs as string arrays, and verificationArgv starting with "vitest". Fix the file; Tau does not fall back to another config.`,
    );
  }

  const values = value.tdd ?? {};

  // Only the Vitest runner exists, so the command must start with vitest.
  if (values.verificationArgv !== undefined && values.verificationArgv[0] !== 'vitest') {
    throw new Error(
      `Invalid TDD config ${source}: verificationArgv must start with "vitest", the only supported runner.`,
    );
  }

  return { source, values };
};

// Repository config overrides user config, which overrides the defaults.
export const loadTddConfig = (location: ConfigLocation): LoadedTddConfig => {
  const { files, ignored } = readTauConfig(location);

  return { ...mergeConfigLayers(defaultTddConfig, defaultSource, files.map(tddLayer)), ignored };
};

export const classifyPath = (config: TddConfig, path: string): 'test' | 'production' | 'other' => {
  const normalizedPath = path.replaceAll('\\', '/');

  if (config.excludedGlobs.some((glob) => matchesGlob(normalizedPath, glob))) {
    return 'other';
  }

  const isTest = config.testGlobs.some((glob) => matchesGlob(normalizedPath, glob));

  if (isTest) {
    return 'test';
  }

  return config.productionGlobs.some((glob) => matchesGlob(normalizedPath, glob))
    ? 'production'
    : 'other';
};
