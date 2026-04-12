import { isAbsolute, normalize, resolve, sep } from 'node:path';

import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import { ConfigValidationError } from './types.js';
import type { Config } from './types.js';

interface ConfigFileInput {
  production?: string[];
  tests?: string[];
}

export const defaultConfig = {
  production: ['src/**/*.{ts,tsx}'],
  tests: ['**/*.test.ts', '**/*.spec.ts'],
} as const satisfies Config;

export const configSchema = Type.Object(
  {
    production: Type.Array(Type.String()),
    tests: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const configFileSchema = Type.Object(
  {
    production: Type.Optional(Type.Array(Type.String())),
    tests: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

const rootGlobPatterns = new Set(['**', '**/*', '**/**']);
const productionTestSuffixPattern = /(?:\.test\.(?:ts|tsx|js)|\.spec\.(?:ts|tsx|js))$/;

const normalizeGlobPattern = (pattern: string) =>
  pattern
    .trim()
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^(?:\.\/)+/, '');

const normalizeAbsoluteGlob = (rootDir: string, pattern: string) => {
  const normalized = normalizeGlobPattern(pattern);
  const absolute = isAbsolute(normalized) ? normalize(normalized) : resolve(rootDir, normalized);

  return absolute.split(sep).join('/');
};

const dedupe = (patterns: string[]) => [...new Set(patterns)];

const fieldFromPath = (path: string) => {
  if (path.length === 0 || path === '/') {
    return '<root>';
  }

  return path.slice(1).replaceAll('/', '.');
};

const validateSchema = (value: unknown): ConfigFileInput => {
  if (Value.Check(configFileSchema, value)) {
    return value;
  }

  const issue = Value.Errors(configFileSchema, value).First();
  const field = issue === undefined ? '<root>' : fieldFromPath(issue.path);
  const reason = issue?.message ?? 'schema validation failed';
  throw new ConfigValidationError(field, reason);
};

const validateProduction = (production: string[]) => {
  if (production.length === 0) {
    throw new ConfigValidationError('production', 'must contain at least one glob');
  }

  for (const pattern of production) {
    if (rootGlobPatterns.has(pattern)) {
      throw new ConfigValidationError('production', 'root-glob **');
    }
  }
};

// Pragmatic overlap heuristic for v1:
// 1. Reject shared literal globs after normalization.
// 2. Reject production patterns that explicitly target test-file suffixes.
const validateOverlap = (production: string[], tests: string[]) => {
  const normalizedTests = new Set(tests.map(normalizeGlobPattern));

  for (const pattern of production) {
    const normalized = normalizeGlobPattern(pattern);

    if (normalizedTests.has(normalized)) {
      throw new ConfigValidationError(
        ['tests', 'production'],
        `shared literal glob: ${JSON.stringify(normalized)}`,
      );
    }

    if (productionTestSuffixPattern.test(normalized)) {
      throw new ConfigValidationError(
        ['tests', 'production'],
        `production glob targets test-file suffix: ${JSON.stringify(normalized)}`,
      );
    }
  }
};

export const normalizeConfig = (rootDir: string, input: ConfigFileInput): Config => {
  const rawProduction = dedupe(
    (input.production ?? defaultConfig.production).map(normalizeGlobPattern),
  );
  const rawTests = dedupe((input.tests ?? defaultConfig.tests).map(normalizeGlobPattern));

  validateProduction(rawProduction);
  validateOverlap(rawProduction, rawTests);

  return {
    production: rawProduction.map((pattern) => normalizeAbsoluteGlob(rootDir, pattern)),
    tests: rawTests.map((pattern) => normalizeAbsoluteGlob(rootDir, pattern)),
  };
};

export const parseConfigFile = (value: unknown) => validateSchema(value);
