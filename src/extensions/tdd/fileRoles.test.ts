import { expect, it } from 'vitest';

import { acceptsFileRole, fileRoles } from './fileRoles.js';

it.each([
  { test: false, production: false, support: false, affected: false },
  { test: false, production: false, support: true, affected: true },
  { test: false, production: true, support: false, affected: true },
  { test: false, production: true, support: true, affected: true },
  { test: true, production: false, support: false, affected: true },
  { test: true, production: false, support: true, affected: true },
  { test: true, production: true, support: false, affected: true },
  { test: true, production: true, support: true, affected: true },
])('accepts roles for test=$test production=$production support=$support', (roles) => {
  expect(acceptsFileRole('focused', roles)).toBe(roles.test);
  expect(acceptsFileRole('full', roles)).toBe(roles.test);
  expect(acceptsFileRole('affected', roles)).toBe(roles.affected);
});

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
