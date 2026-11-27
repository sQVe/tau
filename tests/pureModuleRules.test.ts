import { expect, it } from 'vitest';

import { purityProblems } from './pureModuleExceptions.js';
import { impurities } from './pureModuleImpurities.js';

const readImportSource = (): string => "import { readFile } from 'node:fs/promises';\n";

const readImportAndDateSource = (): string =>
  `${readImportSource()}const first = Date();\nconst second = Date();\n`;

const testRegistry = ['src/pure/decide.ts', 'src/pure/rules.ts'];

const functionPropertySource = (): string =>
  'const install = (api) => {\n  api.run = () => 1;\n};\n';

const aliasedFunctionPropertySource = (): string =>
  'const wrapper = () => 1;\nconst install = (api) => {\n  api.run = wrapper;\n};\n';

const parameterFunctionSource = (): string =>
  'const install = (api, callback) => {\n  api.run = callback;\n};\n';

const classPropertySource = (): string => 'const install = (api) => {\n  api.run = class {};\n};\n';

const aliasedClassPropertySource = (): string =>
  'const handler = class {};\nconst install = (api) => {\n  api.run = handler;\n};\n';

const classDeclarationPropertySource = (): string =>
  'class Handler {}\nconst install = (api) => {\n  api.run = Handler;\n};\n';

const endedBlockClassSource = (): string =>
  'const install = (api) => {\n  {\n    class Handler {}\n    Handler;\n  }\n  api.run = Handler;\n};\n';

const lateClassSource = (): string =>
  'const install = (api) => {\n  api.run = Handler;\n};\nclass Handler {}\n';

const importedFunctionPropertySource = (): string =>
  "import { api } from './rules.js';\napi.run = () => 1;\n";

const importedAliasPropertySource = (): string =>
  "import { api } from './rules.js';\nconst target = api;\ntarget.run = () => 1;\n";

const memberAliasPropertySource = (): string =>
  'export const install = (request) => {\n  const api = request.api;\n  api.run = () => 1;\n};\n';

const endedSwitchClassSource = (): string =>
  'export const install = (api, value) => {\n  switch (value) {\n    case 1:\n      class Handler {}\n      Handler;\n  }\n  api.run = Handler;\n};\n';

const switchCaseClassSource = (): string =>
  'const install = (api) => {\n  switch (api) {\n    case 1:\n      class Handler {}\n      api.run = Handler;\n  }\n};\n';

const importedNestedFunctionPropertySource = (): string =>
  "import { api } from './rules.js';\napi.config.run = () => 1;\n";

const globalFunctionPropertySource = (): string =>
  'globalThis.install = () => 1;\nwindow.handler = () => 1;\nglobal.install = () => 1;\nprocess.handler = () => 1;\nself.install = () => 1;\n';

const localFunctionPropertySource = (): string =>
  'const handlers = {};\nhandlers.run = () => "";\n';

const shadowingImportSource = (): string =>
  "import { api } from './rules.js';\nexport const make = () => {\n  const api = {};\n  api.run = () => 1;\n  return api;\n};\n";

const shadowingParameterSource = (): string =>
  'export const install = (api) => {\n  {\n    const api = {};\n    api.run = () => 1;\n  }\n};\n';

const wrappedFunctionPropertySource = (): string =>
  'const install = (api) => {\n  api.run = (() => 1) as Handler;\n  api.next = (() => 1) satisfies Handler;\n  api.stop = <Handler>(() => 1);\n  api.again = (() => 1)!;\n};\n';

const destructuredEscapingSource = (): string =>
  'export const install = (request) => {\n  const { api } = request;\n  api.run = () => 1;\n};\n';

const importedFunctionValueSource = (): string =>
  "import { api, handler } from './rules.js';\napi.run = handler;\n";

const lateFunctionVariableSource = (): string =>
  'export const install = (api) => {\n  api.run = helper;\n};\nconst helper = () => 1;\n';

const destructuredFunctionSource = (): string =>
  'const helper = () => 1;\nexport const read = (api) => {\n  const { length } = helper;\n  api.run = length;\n};\n';

const hoistedVarFunctionSource = (): string =>
  'export const install = (api) => {\n  if (api) {\n    var later = () => 1;\n  }\n  api.run = later;\n};\n';

const hoistedFunctionPropertySource = (): string =>
  'export const install = (api) => {\n  api.run = later;\n};\nfunction later() {}\n';

const endedBlockFunctionSource = (): string =>
  'export const install = (api) => {\n  if (api) {\n    function later() {}\n    later();\n  }\n  api.run = later;\n};\n';

const siblingFunctionSource = (): string =>
  'const first = (api) => api;\nconst second = () => {\n  const api = {};\n  api.run = () => 1;\n  return api;\n};\n';

const siblingBindingSource = (): string =>
  'const first = () => {\n  const later = () => 1;\n  return later;\n};\nconst second = (api) => {\n  api.run = later;\n};\n';

// Every parameter is a plain escaping value, so the analyser cannot tell a function parameter from
// an object one. This pins that limit until it reads parameter types.
it('does not report a function passed as a parameter when it escapes', () => {
  expect(impurities('src/pure/decide.ts', parameterFunctionSource(), testRegistry)).toEqual([]);
});

it('reports a function assigned to a property of a parameter or an imported binding', () => {
  expect(impurities('src/pure/decide.ts', functionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', aliasedFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', importedFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', importedAliasPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);
});

it('reports an escape through an alias of a parameter member', () => {
  expect(impurities('src/pure/decide.ts', memberAliasPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);
});

it('keeps a class declared in a switch case inside the switch', () => {
  expect(impurities('src/pure/decide.ts', switchCaseClassSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:5: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', endedSwitchClassSource(), testRegistry)).toEqual([]);
});

it('reports a class assigned to a property of a parameter', () => {
  expect(impurities('src/pure/decide.ts', classPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', aliasedClassPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);
});

const wrappedAliasSource = (): string =>
  'export const install = (api) => {\n  const target = api as Api;\n  target.run = () => 1;\n};\n';

const wrappedDestructuredSource = (): string =>
  'export const install = (request) => {\n  const { api } = request as Request;\n  api.run = () => 1;\n};\n';

const wrappedMemberSource = (): string =>
  'export const install = (api) => {\n  (api as Api).run = () => 1;\n};\n';

const staticBlockClassSource = (): string =>
  'class Holder {\n  static {\n    class Handler {}\n    const install = (api) => {\n      api.run = Handler;\n    };\n    install;\n  }\n}\n';

it('reports a class declaration assigned to a property of a parameter', () => {
  expect(impurities('src/pure/decide.ts', classDeclarationPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);
});

it('reports a class declaration assigned before its declaration', () => {
  expect(impurities('src/pure/decide.ts', lateClassSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);
});

it('does not report a class declaration from an ended block', () => {
  expect(impurities('src/pure/decide.ts', endedBlockClassSource(), testRegistry)).toEqual([]);
});

it('reports a class declaration in a switch case', () => {
  expect(impurities('src/pure/decide.ts', switchCaseClassSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:5: assigns a function to a property',
  ]);
});

it('reports a class declaration in a static block', () => {
  expect(impurities('src/pure/decide.ts', staticBlockClassSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:5: assigns a function to a property',
  ]);
});

it('reports a function assigned to a property of a global or of a nested member chain', () => {
  expect(impurities('src/pure/decide.ts', globalFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:1: assigns a function to a property',
    'src/pure/decide.ts:2: assigns a function to a property',
    'src/pure/decide.ts:3: assigns a function to a property',
    'src/pure/decide.ts:4: assigns a function to a property',
    'src/pure/decide.ts:5: assigns a function to a property',
  ]);

  expect(
    impurities('src/pure/decide.ts', importedNestedFunctionPropertySource(), testRegistry),
  ).toEqual(['src/pure/decide.ts:2: assigns a function to a property']);
});

it('does not report a function assigned to a property of a local object', () => {
  expect(impurities('src/pure/decide.ts', localFunctionPropertySource(), testRegistry)).toEqual([]);
});

it('does not report a local that shadows an import', () => {
  expect(impurities('src/pure/decide.ts', shadowingImportSource(), testRegistry)).toEqual([]);
});

it('does not report a local that shadows a parameter', () => {
  expect(impurities('src/pure/decide.ts', shadowingParameterSource(), testRegistry)).toEqual([]);
});

it('does not report a destructured binding as a function', () => {
  expect(impurities('src/pure/decide.ts', destructuredFunctionSource(), testRegistry)).toEqual([]);
});

it('reports a function assigned through a destructured parameter object', () => {
  expect(impurities('src/pure/decide.ts', destructuredEscapingSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);
});

it('does not resolve a function that an import names', () => {
  // The analyzer reads one file, so an imported value has no kind. This case records that limit.
  expect(impurities('src/pure/decide.ts', importedFunctionValueSource(), testRegistry)).toEqual([]);
});

it('reports a function assigned before its function-valued const declaration', () => {
  expect(impurities('src/pure/decide.ts', lateFunctionVariableSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);
});

it('reports a function behind a TypeScript-only wrapper', () => {
  expect(impurities('src/pure/decide.ts', wrappedFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
    'src/pure/decide.ts:3: assigns a function to a property',
    'src/pure/decide.ts:4: assigns a function to a property',
    'src/pure/decide.ts:5: assigns a function to a property',
  ]);
});

it('reports an escape through a TypeScript-only wrapper on the alias', () => {
  expect(impurities('src/pure/decide.ts', wrappedAliasSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', wrappedDestructuredSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:3: assigns a function to a property',
  ]);

  expect(impurities('src/pure/decide.ts', wrappedMemberSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);
});

it('reports a function assigned to a var hoisted out of a block', () => {
  expect(impurities('src/pure/decide.ts', hoistedVarFunctionSource(), testRegistry)).toEqual([
    'src/pure/decide.ts:5: assigns a function to a property',
  ]);
});

it('reports a function assigned before its hoisted declaration', () => {
  expect(impurities('src/pure/decide.ts', hoistedFunctionPropertySource(), testRegistry)).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
  ]);
});

it('does not report a function declared in a block that has ended', () => {
  expect(impurities('src/pure/decide.ts', endedBlockFunctionSource(), testRegistry)).toEqual([]);
});

it('does not let a binding leak out of a sibling function', () => {
  expect(impurities('src/pure/decide.ts', siblingFunctionSource(), testRegistry)).toEqual([]);
  expect(impurities('src/pure/decide.ts', siblingBindingSource(), testRegistry)).toEqual([]);
});

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
      { 'src/pure/decide.ts': ['a function to a property'] },
      functionPropertySource,
    ),
  ).toEqual([
    'src/pure/decide.ts:2: assigns a function to a property',
    'src/pure/decide.ts: unused exception a function to a property',
  ]);
});
