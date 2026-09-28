import { readFile } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';

import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { isMissingFile } from '../../errors/index.js';

export type TddConfig = Static<typeof tddConfigSchema>;

export interface LoadedTddConfig {
  source: string | undefined;
  config: TddConfig;
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

const configFileSchema = Type.Object(
  { tdd: Type.Optional(Type.Partial(tddConfigSchema, { additionalProperties: false })) },
  { additionalProperties: false },
);

export const configFileName = 'tau.json';

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
  configFileName,
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

export const loadTddConfig = async (cwd: string): Promise<LoadedTddConfig> => {
  const source = join(cwd, configFileName);
  let text: string;

  try {
    text = await readFile(source, 'utf8');
  } catch (error) {
    if (isMissingFile(error)) {
      return { source: undefined, config: defaultTddConfig };
    }

    throw new Error(`Could not read TDD config ${source}: ${String(error)}`, { cause: error });
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid TDD config ${source}: not valid JSON (${String(error)})`, {
      cause: error,
    });
  }

  if (!Value.Check(configFileSchema, value)) {
    throw new Error(
      `Invalid TDD config ${source}: ${problem(value)}. Expected {"tdd": {...}} with productionGlobs, testGlobs, testSupportGlobs, and excludedGlobs as string arrays, and verificationArgv starting with "vitest". Fix the file; Tau does not fall back to defaults.`,
    );
  }

  const config = { ...defaultTddConfig, ...value.tdd };

  // Only the Vitest runner exists, so the command must start with vitest.
  if (config.verificationArgv[0] !== 'vitest') {
    throw new Error(
      `Invalid TDD config ${source}: verificationArgv must start with "vitest", the only supported runner.`,
    );
  }

  return { source, config };
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
