import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSync, Visitor } from 'oxc-parser';
import type { MemberExpression, ModuleDeclaration } from 'oxc-parser';
import { expect, it } from 'vitest';

import { versionedRecords } from '../src/extensions/subagents/records.js';

const root = fileURLToPath(new URL('../', import.meta.url));

const sourceFiles = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((path) => path.endsWith('.ts'))
  .map((path) => join('src', path));

const isTest = (path: string) => path.endsWith('.test.ts');
// A relative path through fixtures/, or the bare segment passed to join(); globs and prose do not load.
const fixtureLoad = /['"`](?:\.{1,2}\/(?:[^'"`]*\/)?fixtures(?:\/[^'"`]*)?|fixtures)['"`]/;
const isFixture = (path: string) => path.split(/[/\\]/).includes('fixtures');

// Pure decision modules take every read, clock, and environment value as a fact from the caller.
// Register a module here once its decisions are split from its reads.
const pureModules = ['src/extensions/subagents/workerState.ts'];

const pureAdvice =
  'A pure module must not read records, the clock, randomness, or the environment. Move the read or effect to the caller and pass the value in as a fact.';

const effectMembers = new Set(['Date.now', 'Math.random', 'performance.now', 'process.env']);

// Reads `Date.now` and `Date['now']` alike.
const propertyKey = ({ computed, property }: MemberExpression) => {
  if (property.type === 'Identifier' && !computed) {
    return property.name;
  }

  return property.type === 'Literal' && typeof property.value === 'string'
    ? property.value
    : undefined;
};

const memberName = (node: MemberExpression) => {
  const key = propertyKey(node);

  return node.object.type === 'Identifier' && key !== undefined
    ? `${node.object.name}.${key}`
    : undefined;
};

// Inline `{ type X }` specifiers still load the module under verbatimModuleSyntax, so only a
// top-level `import type` or `export type` is type-only.
const isTypeOnly = (node: ModuleDeclaration) => {
  const typeImport = 'importKind' in node && node.importKind === 'type';
  const typeExport = 'exportKind' in node && node.exportKind === 'type';

  return typeImport || typeExport;
};

const findingLines = (found: string[]) => found.map((finding) => Number(finding.split(':')[1]));

// Lists each runtime import outside the registry, dynamic load, and effect in a registered module.
const impurities = (path: string, source: string, registry: readonly string[]) => {
  const found: string[] = [];

  const at = (offset: number, what: string) =>
    found.push(`${path}:${source.slice(0, offset).split('\n').length}: ${what}`);

  const checkImport = (node: ModuleDeclaration) => {
    const specifier = 'source' in node ? node.source?.value : undefined;

    if (specifier === undefined || isTypeOnly(node)) {
      return;
    }

    const target = posix.join(posix.dirname(path), specifier).replace(/\.js$/, '.ts');

    if (!specifier.startsWith('.') || !registry.includes(target)) {
      at(node.start, `runtime import of ${specifier}`);
    }
  };

  new Visitor({
    ImportDeclaration: checkImport,
    ExportNamedDeclaration: checkImport,
    ExportAllDeclaration: checkImport,
    ImportExpression: (node) => at(node.start, 'dynamic import'),
    CallExpression: (node) => {
      const callee = node.callee.type === 'Identifier' ? node.callee.name : undefined;

      // `Date()` returns the current time as a string.
      if (callee === 'require' || callee === 'Date') {
        at(node.start, `${callee}()`);
      }
    },
    NewExpression: (node) => {
      const isDate = node.callee.type === 'Identifier' && node.callee.name === 'Date';

      if (isDate && node.arguments.length === 0) {
        at(node.start, 'new Date()');
      }
    },
    MemberExpression: (node) => {
      const name = memberName(node);

      if (name !== undefined && effectMembers.has(name)) {
        at(node.start, name);
      }
    },
  }).visit(parseSync(path, source).program);

  return found;
};

it('names each source test after the module beside it', () => {
  const unmatched = sourceFiles.filter(isTest).filter((test) => {
    const name = basename(test).split('.')[0] ?? '';

    const siblings = sourceFiles.filter(
      (path) => dirname(path) === dirname(test) && !isTest(path) && !isFixture(path),
    );

    return !siblings.some((source) => name.startsWith(basename(source, '.ts')));
  });

  expect(unmatched).toEqual([]);
});

it('gives every versioned record schema a format version', () => {
  const unversioned = Object.entries(versionedRecords).filter(([, schema]) => {
    const variants: unknown[] =
      'anyOf' in schema && Array.isArray(schema.anyOf) ? schema.anyOf : [schema];

    return !variants.every((variant) =>
      Number.isInteger(
        (variant as { properties?: { version?: { const?: unknown } } }).properties?.version?.const,
      ),
    );
  });

  expect(unversioned.map(([name]) => name)).toEqual([]);
});

it('writes versioned records only through publishRecord', () => {
  const rawWrites = sourceFiles
    .filter((path) => !isTest(path) && !isFixture(path))
    .filter((path) => {
      const source = readFileSync(join(root, path), 'utf8');

      return Object.keys(versionedRecords).some((name) =>
        new RegExp(String.raw`\bpublish\([^)]*'${name.replace('.', String.raw`\.`)}'`).test(source),
      );
    });

  expect(rawWrites).toEqual([]);
});

it('keeps fixtures out of production modules', () => {
  const importers = sourceFiles
    .filter((path) => !isTest(path) && !isFixture(path))
    .filter((path) => fixtureLoad.test(readFileSync(join(root, path), 'utf8')));

  expect(importers).toEqual([]);
});

it('keeps registered pure modules free of reads and effects', () => {
  const found = pureModules.flatMap((path) =>
    impurities(path, readFileSync(join(root, path), 'utf8'), pureModules),
  );

  expect(found, pureAdvice).toEqual([]);
});

it('refuses reads and effects in a pure module but allows types and other pure modules', () => {
  const registry = ['src/pure/decide.ts', 'src/pure/rules.ts'];

  const allowed = [
    "import type { Task } from '../tasks.js';",
    "import type { Report } from '../records.js';",
    "import { limit } from './rules.js';",
    "export type { Facts } from '../facts.js';",
    'export const decide = (task: Task, report: Report, now: number) =>',
    '  now - task.createdAt > limit && new Date(now).getDay() > 0 && report.outcome;',
  ].join('\n');

  const refused = [
    "import { readReport } from '../records.js';",
    "import { join } from 'node:path';",
    "export { readTask } from '../tasks.js';",
    "export * from './unregistered.js';",
    "import { type Task } from '../tasks.js';",
    "export { type Facts } from '../facts.js';",
    "export const load = () => import('./rules.js');",
    "export const legacy = () => require('./rules.js');",
    'export const now = () => Date.now();',
    "export const nowByKey = () => Date['now']();",
    'export const elapsed = () => performance.now();',
    'export const today = () => new Date();',
    'export const stamp = () => Date();',
    'export const pick = () => Math.random();',
    'export const home = () => process.env.HOME;',
    "export const homeByKey = () => process['env'].HOME;",
  ].join('\n');

  expect(impurities('src/pure/decide.ts', allowed, registry)).toEqual([]);

  expect(findingLines(impurities('src/pure/decide.ts', refused, registry))).toEqual(
    Array.from({ length: 16 }, (_, index) => index + 1),
  );
});
