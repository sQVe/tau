import { expect, it } from 'vitest';

import { normalizeVitestOptions } from './vitestOptions.js';

it.for([
  {
    name: 'CLI exclusions',
    filters: [],
    options: { exclude: ['one/**', 'two/**'] },
    expected: { cliExclude: ['one/**', 'two/**'] },
  },
  {
    name: 'ordinary options',
    filters: ['value.test.ts'],
    options: { globals: true },
    expected: { globals: true },
  },
  {
    name: 'location filters',
    filters: ['value.test.ts:4'],
    options: {},
    expected: { includeTaskLocation: true },
  },
  {
    name: 'explicit location setting',
    filters: ['value.test.ts:4'],
    options: { includeTaskLocation: false },
    expected: { includeTaskLocation: false },
  },
  {
    name: 'typecheck only',
    filters: [],
    options: { typecheck: { only: true } },
    expected: { typecheck: { only: true, enabled: true } },
  },
  {
    name: 'explicit typecheck setting',
    filters: [],
    options: { typecheck: { only: true, enabled: false } },
    expected: { typecheck: { only: true, enabled: false } },
  },
  {
    name: 'clear cache',
    filters: [],
    options: { clearCache: true, watch: true },
    expected: { clearCache: true, watch: false, run: true },
  },
  {
    name: 'list tags',
    filters: [],
    options: { listTags: true, watch: true },
    expected: { listTags: true, watch: false, run: true },
  },
])('normalizes $name before starting Vitest', ({ filters, options, expected }) => {
  expect(normalizeVitestOptions(filters, options)).toEqual(expected);
});
