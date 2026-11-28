import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Visitor, parseSync } from 'oxc-parser';
import type { Expression } from 'oxc-parser';
import { expect, it } from 'vitest';

import { importTable, moduleList } from '../lint/rules/moduleBoundaries.ts';
import config, { testEnvironment, testManagedEnvironment } from '../vite.config.ts';
import { purityProblems } from './pureModuleExceptions.js';
import { findingLines, impurities, memberName, propertyKey } from './pureModuleImpurities.js';
import {
  pureAdvice,
  pureLibraries,
  pureModuleExceptions,
  pureModules,
} from './pureModuleRegistry.js';

const root = fileURLToPath(new URL('../', import.meta.url));

it('keeps every pure library allowance on a registered pure module', () => {
  const unregistered = Object.keys(pureLibraries).filter((path) => !pureModules.includes(path));

  expect(unregistered).toEqual([]);
});

it('keeps registered pure modules free of reads and effects', () => {
  const found = purityProblems(pureModules, pureModuleExceptions, (path: string) =>
    readFileSync(join(root, path), 'utf8'),
  );

  expect(found, pureAdvice).toEqual([]);
});

// Local state, such as review captures under .pi/, can hold test files that no project runs.
const ignoredDirectories = new Set(['node_modules', '.git', '.tau', '.pi', 'dist', 'coverage']);

// Skips ignored directories before descending, so state that appears and vanishes there, such as
// .pi/format-probe-*, is never read. A directory removed during the walk counts as empty.
const walkRepository = (directory: string): string[] => {
  let entries: Dirent[];

  try {
    entries = readdirSync(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  return entries.flatMap((entry) => {
    const path = directory === '' ? entry.name : `${directory}/${entry.name}`;

    if (ignoredDirectories.has(entry.name)) {
      return [];
    }

    return entry.isDirectory() ? walkRepository(path) : [path];
  });
};

const repositoryFiles = () => walkRepository('');

const sourceFiles = walkRepository('src').filter((path) => path.endsWith('.ts'));

const isTest = (path: string) => path.endsWith('.test.ts');
// A relative path through fixtures/, or the bare segment passed to join(); globs and prose do not load.
const fixtureLoad = /['"`](?:\.{1,2}\/(?:[^'"`]*\/)?fixtures(?:\/[^'"`]*)?|fixtures)['"`]/;
const isFixture = (path: string) => path.split(/[/\\]/).includes('fixtures');

// Folders that group files under src/ without forming a module.
const groupingFolders = new Set(['src', 'src/extensions', 'src/skills']);

const isTypeScriptFile = (path: string) => path.endsWith('.ts') && !path.endsWith('.d.ts');

const isProductionSource = (path: string) =>
  isTypeScriptFile(path) && !isTest(path) && !isFixture(path);

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

const isStommeSource = (path: string) =>
  /\.tsx?$/.test(path) && !path.endsWith('.d.ts') && !isFixture(path);

const layoutProblems = (paths: readonly string[]) => {
  const sources = paths.filter(isProductionSource);

  const indexFiles = paths
    .filter((path) => basename(path).startsWith('index.') && !isStommeSource(path))
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
  'Keep source folders free of index files, name a folder module entry after its folder, and keep a module with one production source file as a flat file beside its siblings.';

it('keeps fixtures out of production modules', () => {
  const importers = sourceFiles
    .filter((path) => !isTest(path) && !isFixture(path))
    .filter((path) => fixtureLoad.test(readFileSync(join(root, path), 'utf8')));

  expect(importers).toEqual([]);
});

const versionedRecords = [
  {
    writer: 'src/extensions/modelFallback/fallbackRoute.ts',
    fixtures: 'src/extensions/modelFallback/fixtures/routeState',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
  {
    writer: 'src/extensions/plan/steps.ts',
    fixtures: 'src/extensions/plan/fixtures/planRecord',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
  {
    writer: 'src/inbox/store.ts',
    fixtures: 'src/inbox/fixtures/handover',
    names: [
      'previous.json',
      'previousAnswer.json',
      'version2.json',
      'version2Answer.json',
      'version3.json',
      'version3Handover.json',
      'version3Answer.json',
      'current.json',
      'newer.json',
      'malformed.json',
    ],
  },
  {
    writer: 'src/improvement/event.ts',
    fixtures: 'src/improvement/fixtures',
    names: ['event-v1-merge.json', 'event-v2-pass.json', 'event-v2-class.json'],
  },
  {
    writer: 'src/questionGate/record/record.ts',
    fixtures: 'src/questionGate/record/fixtures/record',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
  {
    writer: 'src/questionGate/decision/decisionRecord.ts',
    fixtures: 'src/questionGate/decision/fixtures/decisionRecord',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
  {
    writer: 'src/extensions/handoverQuestion/question/questionRecord.ts',
    fixtures: 'src/extensions/handoverQuestion/question/fixtures/questionRecord',
    names: ['current.json', 'newer.json', 'malformed.json'],
  },
];

const recordFormatProblems = ({ writer, fixtures, names }: (typeof versionedRecords)[number]) => {
  const source = readFileSync(join(root, writer), 'utf8');
  const problems: string[] = [];

  if (!/version: Type\.Literal\(/u.test(source)) {
    problems.push(`${writer} has no version literal`);
  }

  for (const name of names) {
    if (!repositoryFiles().includes(`${fixtures}/${name}`)) {
      problems.push(`${fixtures} has no ${name}`);
    }
  }

  return problems;
};

it('gives each versioned record format a version and fixtures', () => {
  expect(versionedRecords.flatMap((format) => recordFormatProblems(format))).toEqual([]);
});

// Lists each entry that sorts before the one above it or repeats it.
const registryOrderProblems = (entries: readonly string[]) =>
  entries.flatMap((entry, index) => {
    const previous = entries[index - 1];

    if (previous === undefined) {
      return [];
    }

    if (entry === previous) {
      return [`duplicate ${entry}`];
    }

    return entry < previous ? [`${entry} sorts before ${previous}`] : [];
  });

it('keeps the pure module registry sorted and free of duplicates', () => {
  expect(registryOrderProblems(pureModules)).toEqual([]);
});

it('keeps the module list and import table sorted, free of duplicates, and closed', () => {
  const names = moduleList.map((module) => module.name);
  const rows = Object.keys(importTable);
  const sharedNames = names.filter((name) => name !== 'tau' && !name.startsWith('extensions/'));

  expect(registryOrderProblems(names)).toEqual([]);
  expect(registryOrderProblems(rows)).toEqual([]);
  expect(rows).toEqual(sharedNames);

  for (const module of moduleList) {
    expect(registryOrderProblems(module.publicFiles), module.name).toEqual([]);
  }

  for (const [row, allowed] of Object.entries(importTable)) {
    expect(registryOrderProblems(allowed), row).toEqual([]);

    expect(
      allowed.filter((name) => !sharedNames.includes(name)),
      row,
    ).toEqual([]);
  }
});

it.each([
  { entries: ['a', 'b', 'c'], problems: [] },
  { entries: ['a', 'c', 'b'], problems: ['b sorts before c'] },
  { entries: ['a', 'b', 'b'], problems: ['duplicate b'] },
])('reports $problems for registry $entries', ({ entries, problems }) => {
  expect(registryOrderProblems(entries)).toEqual(problems);
});

it('refuses reads and effects in a pure module but allows types and other pure modules', () => {
  const registry = ['src/pure/decide.ts', 'src/pure/rules.ts'];

  const allowed = [
    "import type { Task } from '../tasks.js';",
    "import type { Report } from '../records.js';",
    "import { limit } from './rules.js';",
    "export type { Facts } from '../facts.js';",
    "import { type Task as InlineTask } from '../tasks.js';",
    "export { type Facts as InlineFacts } from '../facts.js';",
    'export const decide = (task: Task, report: Report, now: number) =>',
    '  now - task.createdAt > limit && new Date(now).getDay() > 0 && report.outcome;',
  ].join('\n');

  const refused = [
    "import { readReport } from '../records.js';",
    "import { join } from 'node:path';",
    "export { readTask } from '../tasks.js';",
    "export * from './unregistered.js';",
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
    "import { Value } from 'typebox/value';",
    'export const install = (api) => { api.run = () => 1; };',
  ].join('\n');

  const schemaLibrary = "import { Value } from 'typebox/value';";

  expect(impurities('src/pure/decide.ts', allowed, registry)).toEqual([]);

  expect(findingLines(impurities('src/pure/decide.ts', refused, registry))).toEqual(
    Array.from({ length: 16 }, (_, index) => index + 1),
  );

  expect(impurities('src/schema.ts', schemaLibrary, registry)).toEqual([]);
});

it('keeps src/ free of one-file folders and folder modules without an entry', () => {
  const paths = walkRepository('src');

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
    'src/instructions/writing.md',
    'src/skills/pr/SKILL.md',
    'src/extensions/themes.ts',
    'src/extensions/commit/commit.ts',
    'src/extensions/commit/tool.ts',
    'src/extensions/commit/fixtures/repository.ts',
    'src/extensions/snippets/snippets.ts',
    'src/extensions/snippets/menu.ts',
    'src/extensions/snippets/snippets/verify.md',
    'src/extensions/subagents/subagents.ts',
    'src/extensions/subagents/launch.ts',
    'src/extensions/subagents/profiles/scout.md',
  ];

  const refused = [
    'src/skills/pr/index.md',
    'src/models/index.d.ts',
    'src/errors/errors.ts',
    'src/errors/errors.test.ts',
    'src/extensions/bareRoot/bareRoot.ts',
    'src/extensions/bareRoot/fixtures/fake.ts',
    'src/extensions/tdd/config.ts',
  ];

  expect(layoutProblems(allowed)).toEqual([]);

  expect(layoutProblems(refused)).toEqual([
    'src/skills/pr/index.md: index file',
    'src/models/index.d.ts: index file',
    'src/errors/: one production source file',
    'src/extensions/bareRoot/: one production source file',
    'src/extensions/tdd/: one production source file',
    'src/extensions/tdd/: no entry file tdd.ts',
  ]);
});

it('puts every test file in exactly one Vitest project', () => {
  const testFiles = repositoryFiles().filter((path) => path.endsWith('.test.ts'));

  const projects = (config.test?.projects ?? []) as {
    test: { name: string; include: string[]; exclude: string[] };
  }[];

  const projectsOf = (file: string) =>
    projects
      .map(({ test }) => test)
      .filter(({ include, exclude }) => {
        const included = include.some((pattern) => posix.matchesGlob(file, pattern));
        const excluded = exclude.some((pattern) => posix.matchesGlob(file, pattern));

        return included && !excluded;
      })
      .map(({ name }) => name);

  const misplaced = testFiles
    .map((file) => ({ file, owners: projectsOf(file) }))
    .filter(({ owners }) => owners.length !== 1);

  expect(projects).toHaveLength(10);
  expect(testFiles.length).toBeGreaterThan(100);
  expect(misplaced).toEqual([]);
});

const environmentAccess = (node: Expression) =>
  node.type === 'MemberExpression' && memberName(node) === 'process.env';

// Lists the variables a source reads from process.env. Writes, deletes, and text are not reads.
const environmentReads = (path: string, source: string): string[] => {
  const found: string[] = [];
  const notReads = new Set<unknown>();

  new Visitor({
    AssignmentExpression: (node) => {
      if (node.operator === '=') {
        notReads.add(node.left);
      }
    },
    UnaryExpression: (node) => {
      if (node.operator === 'delete') {
        notReads.add(node.argument);
      }
    },
    MemberExpression: (node) => {
      const name = propertyKey(node);

      if (environmentAccess(node.object) && name !== undefined && !notReads.has(node)) {
        found.push(name);
      }
    },
    BinaryExpression: (node) => {
      const { left } = node;

      if (node.operator === 'in' && left.type === 'Literal' && environmentAccess(node.right)) {
        found.push(String(left.value));
      }
    },
  }).visit(parseSync(path, source).program);

  return found;
};

it('handles every environment variable that test code reads in the cached test tasks', () => {
  const isTestCode = (path: string) =>
    isTest(path) || isFixture(path) || /^tests\/[^/]+\.ts$/.test(path);

  const testCode = repositoryFiles().filter((path) => path.endsWith('.ts') && isTestCode(path));

  const handled = new Set([...testEnvironment, ...testManagedEnvironment]);

  const unhandled = testCode.flatMap((file) =>
    environmentReads(file, readFileSync(join(root, file), 'utf8'))
      .filter((name) => !handled.has(name))
      .map(
        (name) =>
          `${file}: reads ${name}, which is not in testEnvironment or testManagedEnvironment`,
      ),
  );

  expect(testCode.length).toBeGreaterThan(100);
  expect(unhandled).toEqual([]);
});

it('counts reads of process.env and ignores writes, deletes, comments, and strings', () => {
  const reads = [
    'export const a = process.env.ONE;',
    "export const b = process.env['TWO'];",
    'export const c = process.env[`THREE`];',
    'export const d = process.env?.FOUR;',
    "export const e = 'FIVE' in process.env;",
    "export const f = process['env'].SIX;",
    'process.env.SEVEN += 1;',
  ].join('\n');

  const ignored = [
    'process.env.EIGHT = "x";',
    "process.env['NINE'] = 'x';",
    'delete process.env.TEN;',
    '// process.env.ELEVEN',
    '/* process.env.TWELVE */',
    "export const text = 'process.env.THIRTEEN';",
    'export const template = `process.env.FOURTEEN`;',
    // oxlint-disable-next-line no-template-curly-in-string -- The probe source holds the placeholder.
    'export const dynamic = process.env[`A${name}`];',
  ].join('\n');

  expect(environmentReads('tests/probe.ts', reads)).toEqual([
    'ONE',
    'TWO',
    'THREE',
    'FOUR',
    'FIVE',
    'SIX',
    'SEVEN',
  ]);

  expect(environmentReads('tests/probe.ts', ignored)).toEqual([]);
});
