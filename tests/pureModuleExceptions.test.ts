import { expect, it } from 'vitest';

import { purityProblems } from './pureModuleExceptions.js';

const readImportSource = (): string => "import { readFile } from 'node:fs/promises';\n";

const readImportAndDateSource = (): string =>
  `${readImportSource()}const first = Date();\nconst second = Date();\n`;

it('applies each pure module exception to one finding and reports a stale exception', () => {
  const modules = ['src/pure/decide.ts'];

  expect(purityProblems(modules, {}, readImportSource)).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
  ]);

  expect(
    purityProblems(
      modules,
      { 'src/pure/decide.ts': ['runtime import of node:fs/promises'] },
      readImportSource,
    ),
  ).toEqual([]);

  expect(
    purityProblems(
      modules,
      { 'src/pure/decide.ts': ['assigns a function to a property'] },
      readImportSource,
    ),
  ).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/decide.ts: unused exception assigns a function to a property',
  ]);

  expect(
    purityProblems(
      modules,
      { 'src/pure/other.ts': ['runtime import of node:fs/promises'] },
      readImportSource,
    ),
  ).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/other.ts: exception for an unregistered module',
  ]);
});

it('reports an exception reason that matches more than one finding', () => {
  expect(
    purityProblems(
      ['src/pure/decide.ts'],
      { 'src/pure/decide.ts': ['Date()'] },
      readImportAndDateSource,
    ),
  ).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/decide.ts:2: Date()',
    'src/pure/decide.ts:3: Date()',
    'src/pure/decide.ts: exception Date() matches 2 findings',
  ]);
});

it('does not let an empty or partial exception reason suppress a finding', () => {
  const modules = ['src/pure/decide.ts'];

  expect(purityProblems(modules, { 'src/pure/decide.ts': [''] }, readImportSource)).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/decide.ts: unused exception ',
  ]);

  expect(
    purityProblems(
      modules,
      { 'src/pure/decide.ts': ['runtime import of node:fs'] },
      readImportSource,
    ),
  ).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/decide.ts: unused exception runtime import of node:fs',
  ]);
});
