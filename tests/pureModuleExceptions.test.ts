import { expect, it } from 'vitest';

import { purityProblems } from './pureModuleExceptions.js';

const readImportSource = (): string => "import { readFile } from 'node:fs/promises';\n";

const readImportAndDateSource = (): string =>
  `${readImportSource()}const first = Date();\nconst second = Date();\n`;

const modules = ['src/pure/decide.ts'];

it('reports a finding when no exception names it', () => {
  expect(purityProblems(modules, {}, readImportSource)).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
  ]);
});

it('suppresses the finding an exact exception names', () => {
  expect(
    purityProblems(
      modules,
      { 'src/pure/decide.ts': ['runtime import of node:fs/promises'] },
      readImportSource,
    ),
  ).toEqual([]);
});

it('reports an exception that names no finding', () => {
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
});

it('reports an exception for an unregistered module', () => {
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

it('keeps the findings that an exception does not name', () => {
  expect(
    purityProblems(
      ['src/pure/decide.ts'],
      { 'src/pure/decide.ts': ['runtime import of node:fs/promises'] },
      readImportAndDateSource,
    ),
  ).toEqual(['src/pure/decide.ts:2: Date()', 'src/pure/decide.ts:3: Date()']);
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

it('does not let an empty exception reason suppress a finding', () => {
  expect(purityProblems(modules, { 'src/pure/decide.ts': [''] }, readImportSource)).toEqual([
    'src/pure/decide.ts:1: runtime import of node:fs/promises',
    'src/pure/decide.ts: unused exception ',
  ]);
});

it('does not let a partial exception reason suppress a finding', () => {
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
