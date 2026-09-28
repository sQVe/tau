import { expect, it } from 'vitest';

import type { TddConfig } from './config.js';
import { mergeConfigLayers } from './configLayers.js';

const defaults: TddConfig = {
  productionGlobs: ['src/**'],
  testGlobs: ['**/*.test.ts'],
  testSupportGlobs: ['tests/**'],
  excludedGlobs: ['**/dist/**'],
  verificationArgv: ['vitest', 'run'],
};

const user = { source: 'user', values: { productionGlobs: ['lib/**'], excludedGlobs: ['a/**'] } };
const project = { source: 'project', values: { excludedGlobs: [] } };

it.each([
  { layers: [], production: ['src/**'], excluded: ['**/dist/**'], from: ['default', 'default'] },
  { layers: [user], production: ['lib/**'], excluded: ['a/**'], from: ['user', 'user'] },
  { layers: [project], production: ['src/**'], excluded: [], from: ['default', 'project'] },
  { layers: [user, project], production: ['lib/**'], excluded: [], from: ['user', 'project'] },
])(
  'takes each field from the last layer that sets it: $from',
  ({ layers, production, excluded, from }) => {
    const merged = mergeConfigLayers(defaults, 'default', layers);

    expect(merged.config).toEqual({
      ...defaults,
      productionGlobs: production,
      excludedGlobs: excluded,
    });

    expect(merged.sources).toEqual({
      productionGlobs: from[0],
      testGlobs: 'default',
      testSupportGlobs: 'default',
      excludedGlobs: from[1],
      verificationArgv: 'default',
    });
  },
);
