import { expect, it } from 'vitest';

import { defaultTddConfig } from './config.js';
import { configSummary } from './render.js';

it('renders the runner name as a plain string', () => {
  const summary = configSummary({
    config: { ...defaultTddConfig, runner: 'nextest' },
    sources: {
      runner: 'repository',
      productionGlobs: 'built-in default',
      testGlobs: 'built-in default',
      testSupportGlobs: 'built-in default',
      excludedGlobs: 'built-in default',
      verificationArgv: 'built-in default',
    },
    ignored: undefined,
  });

  expect(summary).toContain('Runner (repository): nextest');
});

it('renders the Cargo options only when a file sets them', () => {
  const sources = {
    runner: 'repository',
    productionGlobs: 'built-in default',
    testGlobs: 'built-in default',
    testSupportGlobs: 'built-in default',
    excludedGlobs: 'built-in default',
    verificationArgv: 'built-in default',
  };

  const unset = configSummary({
    config: { ...defaultTddConfig, runner: 'nextest' },
    sources,
    ignored: undefined,
  });

  const set = configSummary({
    config: {
      ...defaultTddConfig,
      runner: 'nextest',
      cargoManifestPath: 'backend/Cargo.toml',
      cargoLocked: true,
    },
    sources: { ...sources, cargoManifestPath: 'repository', cargoLocked: 'user' },
    ignored: undefined,
  });

  expect(unset).not.toContain('Cargo');
  expect(set).toContain('Cargo manifest (repository): backend/Cargo.toml');
  expect(set).toContain('Cargo --locked (user): true');
});
