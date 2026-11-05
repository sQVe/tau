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
