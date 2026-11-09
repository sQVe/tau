import { expect, it } from 'vitest';

import type { TddConfig } from './config.js';
import { mergeConfigLayers } from './configLayers.js';
import type { TddConfigSources } from './configLayers.js';

const runnerDefaults = (runner: string, testGlobs: string[]): TddConfig => ({
  runner,
  productionGlobs: ['{src,lib}/**/*.ts'],
  testGlobs,
  testSupportGlobs: ['tests/**/*.ts'],
  excludedGlobs: ['**/dist/**'],
  verificationArgv: [runner, 'run'],
});

const alpha = runnerDefaults('alpha', ['**/*.alpha.test.ts']);
const beta = runnerDefaults('beta', ['**/*.beta.test.ts']);

const table: Record<string, TddConfig> = { alpha, beta };

const defaultsFor = (runnerName: string): TddConfig | undefined => table[runnerName];

const sourceOf = (source: string): TddConfigSources => ({
  runner: source,
  productionGlobs: source,
  testGlobs: source,
  testSupportGlobs: source,
  excludedGlobs: source,
  verificationArgv: source,
});

it('starts a changed runner from its defaults and resets every source', () => {
  const user = {
    source: 'user',
    values: { testGlobs: ['custom/**/*.ts'], excludedGlobs: ['a/**'] },
  };

  const repository = { source: 'repository', values: { runner: 'beta' } };

  const merged = mergeConfigLayers('alpha', defaultsFor, 'built-in default', [user, repository]);

  expect(merged.config).toEqual(beta);

  expect(merged.sources).toEqual({ ...sourceOf('built-in default'), runner: 'repository' });
});

it('drops the Cargo options and their sources when a layer changes the runner', () => {
  const user = {
    source: 'user',
    values: { runner: 'beta', cargoManifestPath: 'backend/Cargo.toml', cargoLocked: true },
  };

  const repository = { source: 'repository', values: { runner: 'alpha' } };

  const merged = mergeConfigLayers('alpha', defaultsFor, 'built-in default', [user, repository]);

  expect(merged.config).toEqual(alpha);
  expect(merged.sources).toEqual({ ...sourceOf('built-in default'), runner: 'repository' });
});

it('keeps the current runner and merges per field when a layer omits the runner', () => {
  const user = { source: 'user', values: { testGlobs: ['custom/**/*.ts'] } };
  const repository = { source: 'repository', values: { productionGlobs: ['lib/**'] } };

  const merged = mergeConfigLayers('alpha', defaultsFor, 'built-in default', [user, repository]);

  expect(merged.config).toEqual({
    ...alpha,
    testGlobs: ['custom/**/*.ts'],
    productionGlobs: ['lib/**'],
  });

  expect(merged.sources).toEqual({
    ...sourceOf('built-in default'),
    testGlobs: 'user',
    productionGlobs: 'repository',
  });
});

it('keeps the current runner and merges per field when a layer restates it', () => {
  const layer = { source: 'user', values: { runner: 'alpha', testGlobs: ['custom/**/*.ts'] } };

  const merged = mergeConfigLayers('alpha', defaultsFor, 'built-in default', [layer]);

  expect(merged.config).toEqual({ ...alpha, testGlobs: ['custom/**/*.ts'] });

  expect(merged.sources).toEqual({
    ...sourceOf('built-in default'),
    runner: 'user',
    testGlobs: 'user',
  });
});

it('switches back to an earlier runner and resets the fields it changed', () => {
  const toBeta = { source: 'repository', values: { runner: 'beta', testGlobs: ['b/**'] } };
  const backToAlpha = { source: 'user', values: { runner: 'alpha' } };

  const merged = mergeConfigLayers('alpha', defaultsFor, 'built-in default', [toBeta, backToAlpha]);

  expect(merged.config).toEqual(alpha);

  expect(merged.sources).toEqual({ ...sourceOf('built-in default'), runner: 'user' });
});

it('keeps earlier fields when a later layer restates the current runner', () => {
  const first = { source: 'user', values: { testGlobs: ['custom/**/*.ts'] } };
  const second = { source: 'repository', values: { runner: 'alpha' } };

  const merged = mergeConfigLayers('alpha', defaultsFor, 'built-in default', [first, second]);

  expect(merged.config.testGlobs).toEqual(['custom/**/*.ts']);
  expect(merged.sources.testGlobs).toBe('user');
});

it('refuses a default runner that is not in the table', () => {
  expect(() => mergeConfigLayers('missing', defaultsFor, 'built-in default', [])).toThrow(
    'Unknown TDD runner: missing',
  );
});

it('refuses a layer that names a runner that is not in the table', () => {
  const layer = { source: 'repository', values: { runner: 'missing' } };

  expect(() => mergeConfigLayers('alpha', defaultsFor, 'built-in default', [layer])).toThrow(
    'Unknown TDD runner: missing',
  );
});

it('takes each field from the last layer that sets it without a runner change', () => {
  const first = { source: 'first', values: { testGlobs: ['first/**/*.ts'] } };
  const second = { source: 'second', values: { testGlobs: ['second/**/*.ts'] } };

  const merged = mergeConfigLayers('alpha', defaultsFor, 'built-in default', [first, second]);

  expect(merged.config.testGlobs).toEqual(['second/**/*.ts']);
  expect(merged.sources.testGlobs).toBe('second');
});
