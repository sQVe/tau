import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix, relative } from 'node:path';
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
const pureModules = [
  'scripts/piVersionDrift.ts',
  'scripts/tokenUsageReport.ts',
  'src/controlTools.ts',
  'src/models/allowedModels.ts',
  'src/reviewCapture/freshness.ts',
  'src/extensions/askUserQuestion/questionnaire.ts',
  'src/extensions/askUserQuestion/validation.ts',
  'src/extensions/compaction/reminder.ts',
  'src/extensions/prFeedback/checkEvidence.ts',
  'src/extensions/prFeedback/threads.ts',
  'src/extensions/prFeedback/writes.ts',
  'src/extensions/slice/blockers.ts',
  'src/extensions/slice/writes.ts',
  'src/extensions/snippets/history.ts',
  'src/extensions/snippets/insertion.ts',
  'src/extensions/snippets/query.ts',
  'src/extensions/tauSkills/requiredFor.ts',
  'src/extensions/tdd/configLayers.ts',
  'src/extensions/subagents/bashOutputCap.ts',
  'src/extensions/subagents/compactionWorkers.ts',
  'src/extensions/subagents/incompleteReport.ts',
  'src/extensions/subagents/noticeDelivery.ts',
  'src/extensions/subagents/piStop.ts',
  'src/extensions/subagents/reportCap.ts',
  'src/extensions/subagents/trackerRouting.ts',
  'src/extensions/subagents/workerModels.ts',
  'src/extensions/subagents/workerPackages.ts',
  'src/extensions/subagents/workerState.ts',
];

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

// Folders that group files under src/ without forming a module.
const groupingFolders = new Set(['src', 'src/extensions', 'src/skills', 'src/instructions']);

const isProductionSource = (path: string) =>
  path.endsWith('.ts') && !isTest(path) && !isFixture(path);

const parentFolders = (path: string) =>
  path
    .split('/')
    .slice(0, -1)
    .map((_, index, segments) => segments.slice(0, index + 1).join('/'));

// The module folder a file belongs to: src/<module>/ or src/extensions/<module>/.
const moduleFolderOf = (path: string) => {
  const depth = path.startsWith('src/extensions/') ? 3 : 2;
  const segments = path.split('/');
  const folder = segments.slice(0, depth).join('/');

  return segments.length > depth && !groupingFolders.has(folder) ? folder : undefined;
};

// Lists index files, folders with one production source file, and folder modules without an
// entry file named after the folder. Takes every file below src/ as a POSIX path.
const layoutProblems = (paths: readonly string[]) => {
  const sources = paths.filter(isProductionSource);

  const indexFiles = paths
    .filter((path) => basename(path).startsWith('index.'))
    .map((path) => `${path}: index file`);

  const folders = [...new Set(paths.flatMap(parentFolders))].filter(
    (folder) => !groupingFolders.has(folder),
  );

  const oneFileFolders = folders
    .filter((folder) => sources.filter((path) => path.startsWith(`${folder}/`)).length === 1)
    .map((folder) => `${folder}/: one production source file`);

  const modules = [...new Set(sources.flatMap((path) => moduleFolderOf(path) ?? []))];

  const missingEntries = modules
    .filter((folder) => !sources.includes(`${folder}/${basename(folder)}.ts`))
    .map((folder) => `${folder}/: no entry file ${basename(folder)}.ts`);

  return [...indexFiles, ...oneFileFolders, ...missingEntries];
};

const layoutAdvice =
  'Name a folder module entry after its folder, and keep a module with one production source file as a flat file beside its siblings.';

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

// tests/lint.test.ts writes these probe folders under src/ while other test files run.
const isLintProbe = (path: string) =>
  path.split('/').some((segment) => segment.startsWith('tau-lint-'));

it('keeps src/ free of index files, one-file folders, and folder modules without an entry', () => {
  const paths = readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => posix.join(relative(root, entry.parentPath).replaceAll('\\', '/'), entry.name))
    .filter((path) => !isLintProbe(path));

  expect(layoutProblems(paths), layoutAdvice).toEqual([]);
});

it('refuses index files, one-file folders, and missing entries but allows flat files and assets', () => {
  const allowed = [
    'src/tau.ts',
    'src/keys.ts',
    'src/keys.test.ts',
    'src/models/models.ts',
    'src/models/models.test.ts',
    'src/models/allowedModels.ts',
    'src/instructions/coding.md',
    'src/skills/pr/SKILL.md',
    'src/extensions/coding.ts',
    'src/extensions/commit/commit.ts',
    'src/extensions/commit/tool.ts',
    'src/extensions/commit/fixtures/repository.ts',
    'src/extensions/snippets/snippets.ts',
    'src/extensions/snippets/menu.ts',
    'src/extensions/snippets/snippets/simplify.md',
    'src/extensions/subagents/subagents.ts',
    'src/extensions/subagents/profiles/scout.md',
    'src/extensions/subagents/controller/controller.ts',
    'src/extensions/subagents/controller/record.ts',
  ];

  const refused = [
    'src/index.ts',
    'src/errors/errors.ts',
    'src/errors/errors.test.ts',
    'src/extensions/index.ts',
    'src/extensions/bareRoot/bareRoot.ts',
    'src/extensions/bareRoot/fixtures/fake.ts',
    'src/extensions/tdd/index.ts',
    'src/extensions/tdd/config.ts',
    'src/skills/pr/index.md',
  ];

  expect(layoutProblems(allowed)).toEqual([]);

  expect(layoutProblems(refused)).toEqual([
    'src/index.ts: index file',
    'src/extensions/index.ts: index file',
    'src/extensions/tdd/index.ts: index file',
    'src/skills/pr/index.md: index file',
    'src/errors/: one production source file',
    'src/extensions/bareRoot/: one production source file',
    'src/extensions/tdd/: no entry file tdd.ts',
  ]);
});
