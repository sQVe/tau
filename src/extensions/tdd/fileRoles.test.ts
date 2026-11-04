import { expect, it } from 'vitest';

import { fileRoles } from './fileRoles.js';

it.each([
  {
    testMatch: false,
    productionMatch: false,
    testFilesCanBeProduction: false,
    expected: { test: false, production: false },
  },
  {
    testMatch: false,
    productionMatch: false,
    testFilesCanBeProduction: true,
    expected: { test: false, production: false },
  },
  {
    testMatch: false,
    productionMatch: true,
    testFilesCanBeProduction: false,
    expected: { test: false, production: true },
  },
  {
    testMatch: false,
    productionMatch: true,
    testFilesCanBeProduction: true,
    expected: { test: false, production: true },
  },
  {
    testMatch: true,
    productionMatch: false,
    testFilesCanBeProduction: false,
    expected: { test: true, production: false },
  },
  {
    testMatch: true,
    productionMatch: false,
    testFilesCanBeProduction: true,
    expected: { test: true, production: false },
  },
  {
    testMatch: true,
    productionMatch: true,
    testFilesCanBeProduction: false,
    expected: { test: true, production: false },
  },
  {
    testMatch: true,
    productionMatch: true,
    testFilesCanBeProduction: true,
    expected: { test: true, production: true },
  },
])(
  'file roles for test=$testMatch production=$productionMatch overlap=$testFilesCanBeProduction',
  (facts) => {
    expect(fileRoles(facts)).toEqual(facts.expected);
  },
);
