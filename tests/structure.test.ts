import { readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSync, Visitor } from 'oxc-parser';
import type { Expression, MemberExpression, ModuleDeclaration } from 'oxc-parser';
import { expect, it } from 'vitest';

import { importTable, moduleList } from '../lint/rules/moduleBoundaries.ts';
import { versionedRecords } from '../src/extensions/subagents/records.js';
import config, { testEnvironment, testManagedEnvironment } from '../vite.config.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

// Local state, such as review captures under .pi/, can hold test files that no project runs.
const ignoredDirectories = new Set(['node_modules', '.git', '.tau', '.pi', 'dist', 'coverage']);

// tests/lint.test.ts writes these probe folders under src/ while other test files run.
const isLintProbe = (path: string) =>
  path.split('/').some((segment) => segment.startsWith('tau-lint-'));

// Skips ignored directories before descending, so state that appears and vanishes there, such as
// .pi/format-probe-* and the lint probe folders, is never read. A directory removed during the
// walk counts as empty.
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

    if (ignoredDirectories.has(entry.name) || isLintProbe(path)) {
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

// Pure decision modules take every read, clock, and environment value as a fact from the caller.
// Register a module here once its decisions are split from its reads.
const pureModules = [
  'scripts/pathCommands.ts',
  'scripts/piSmokeChecks.ts',
  'scripts/piVersionDrift.ts',
  'scripts/tokenUsageReport.ts',
  'src/checkRecord/reuseDecision.ts',
  'src/codemode/budget.ts',
  'src/codemode/controlTools.ts',
  'src/config/allowedModels.ts',
  'src/config/repositoryEntry.ts',
  'src/dialog/eligibility.ts',
  'src/extensions/askUserQuestion/questionnaire.ts',
  'src/extensions/askUserQuestion/typedAnswerGuard.ts',
  'src/extensions/askUserQuestion/validation.ts',
  'src/extensions/commit/autosquash.ts',
  'src/extensions/commit/fileRequests.ts',
  'src/extensions/compaction/reminder.ts',
  'src/extensions/draftReview/reviewDecisions.ts',
  'src/extensions/fullCheck/idleDecision.ts',
  'src/extensions/fullCheck/mutationVerdict.ts',
  'src/extensions/mergeWatch/autoMergeRequest.ts',
  'src/extensions/mergeWatch/deliveryStep.ts',
  'src/extensions/mergeWatch/watchOutcome.ts',
  'src/extensions/mergeWatch/watchStart.ts',
  'src/extensions/pr/evidenceDecisions.ts',
  'src/extensions/pr/reuseDecisions.ts',
  'src/extensions/pr/reviewBotDecisions.ts',
  'src/extensions/pr/targetDecisions.ts',
  'src/extensions/pr/verifyDecisions.ts',
  'src/extensions/prFeedback/checkEvidence.ts',
  'src/extensions/prFeedback/feedbackBounds.ts',
  'src/extensions/prFeedback/threads.ts',
  'src/extensions/prFeedback/writes.ts',
  'src/extensions/slice/blockers.ts',
  'src/extensions/slice/foreignWrites.ts',
  'src/extensions/slice/ownership.ts',
  'src/extensions/slice/startDecisions.ts',
  'src/extensions/slice/writes.ts',
  'src/extensions/snippets/history.ts',
  'src/extensions/snippets/insertion.ts',
  'src/extensions/snippets/query.ts',
  'src/extensions/stack/chainDecisions.ts',
  'src/extensions/stack/checkDecisions.ts',
  'src/extensions/stack/historyDecisions.ts',
  'src/extensions/stack/readResult.ts',
  'src/extensions/statusbar/reuseDecision.ts',
  'src/extensions/subagents/acceptanceRefusal.ts',
  'src/extensions/subagents/bashOutputCap.ts',
  'src/extensions/subagents/capacityRefusal.ts',
  'src/extensions/subagents/compactionWorkers.ts',
  'src/extensions/subagents/controller/discoveryDecision.ts',
  'src/extensions/subagents/incompleteReport.ts',
  'src/extensions/subagents/launchEnvironment.ts',
  'src/extensions/subagents/modelRoutes.ts',
  'src/extensions/subagents/noticeDelivery.ts',
  'src/extensions/subagents/passiveWait.ts',
  'src/extensions/subagents/piStop.ts',
  'src/extensions/subagents/qaBrief.ts',
  'src/extensions/subagents/reportCap.ts',
  'src/extensions/subagents/retentionDecision.ts',
  'src/extensions/subagents/skillToolsRefusal.ts',
  'src/extensions/subagents/startupFailureDecision.ts',
  'src/extensions/subagents/summaryLength.ts',
  'src/extensions/subagents/taskFormat.ts',
  'src/extensions/subagents/ticketPath.ts',
  'src/extensions/subagents/workerModels.ts',
  'src/extensions/subagents/workerPackages.ts',
  'src/extensions/subagents/workerState.ts',
  'src/extensions/subagents/workerTools.ts',
  'src/extensions/tauSkills/requiredFor.ts',
  'src/extensions/tdd/configLayers.ts',
  'src/extensions/tdd/inputGlob.ts',
  'src/extensions/tdd/worktreePath.ts',
  'src/extensions/tracker/candidateFit.ts',
  'src/extensions/tracker/promptLines.ts',
  'src/fileLock/lockHolderDecision.ts',
  'src/github/repositoryTargetDecisions.ts',
  'src/process/stateDecision.ts',
  'src/reviewCapture/evidenceDecisions.ts',
  'src/reviewCapture/fixScope.ts',
  'src/reviewCapture/freshness.ts',
  'src/reviewCapture/gitQuotedName.ts',
  'src/schema.ts',
  'src/shell.ts',
  'tests/adrIndexMark.ts',
];

const pureAdvice =
  'A pure module must not read records, the clock, randomness, or the environment. Move the read or effect to the caller and pass the value in as a fact.';

const effectMembers = new Set(['Date.now', 'Math.random', 'performance.now', 'process.env']);

// Reads `Date.now` and `Date['now']` alike.
const propertyKey = ({ computed, property }: MemberExpression) => {
  if (property.type === 'Identifier' && !computed) {
    return property.name;
  }

  if (property.type === 'TemplateLiteral' && property.expressions.length === 0) {
    return property.quasis[0]?.value.cooked ?? undefined;
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

// The outside libraries a registered module may import, by module path.
const pureLibraries: Readonly<Record<string, readonly string[]>> = {
  'src/schema.ts': ['typebox/value'],
};

const isPureLibrary = (path: string, specifier: string) =>
  pureLibraries[path]?.includes(specifier) ?? false;

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

    if (isPureLibrary(path, specifier)) {
      return;
    }

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

const environmentAccess = (node: Expression) =>
  node.type === 'MemberExpression' && memberName(node) === 'process.env';

// Lists the variables a source reads from process.env. Writes, deletes, and text are not reads.
const environmentReads = (path: string, source: string) => {
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

// Folders that group files under src/ without forming a module.
const groupingFolders = new Set(['src', 'src/extensions', 'src/skills']);

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

const sortedImportTable = (table: Readonly<Record<string, readonly string[]>>) =>
  Object.fromEntries(Object.entries(table).map(([row, allowed]) => [row, [...allowed].toSorted()]));

const importTableHeading = '### Target modules and import table';

const headingPattern = /^#{1,6} /;

const importTableRowPattern = /^\| `([^`]+)`\s*\|\s*(.*?)\s*\|$/;

const dependencyListPattern = /^`[^`]+`(, `[^`]+`)*$/;

const parseDependencies = (cell: string): string[] | undefined => {
  if (cell === 'nothing') {
    return [];
  }

  if (!dependencyListPattern.test(cell)) {
    return undefined;
  }

  return cell.split(', ').map((item) => item.slice(1, -1));
};

const parseImportTable = (markdown: string) => {
  const lines = markdown.split('\n');
  const start = lines.indexOf(importTableHeading);

  if (start === -1) {
    return { table: {}, problems: ['missing table section'] };
  }

  const nextHeading = lines.findIndex((line, index) => index > start && headingPattern.test(line));
  const end = nextHeading === -1 ? lines.length : nextHeading;
  const table: Record<string, string[]> = {};
  const problems: string[] = [];

  let tableLineCount = 0;

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('|')) {
      continue;
    }

    if (index < start || index >= end) {
      problems.push(`row outside the table section: ${line}`);

      continue;
    }

    tableLineCount += 1;

    if (tableLineCount <= 2) {
      continue;
    }

    const match = importTableRowPattern.exec(line);

    if (match === null) {
      problems.push(`malformed row: ${line}`);

      continue;
    }

    const [, moduleName = '', cell = ''] = match;
    const dependencies = parseDependencies(cell);

    if (Object.hasOwn(table, moduleName)) {
      problems.push(`duplicate row: ${moduleName}`);
    } else if (dependencies === undefined) {
      problems.push(`malformed dependencies for ${moduleName}: ${cell}`);
    } else {
      table[moduleName] = dependencies;
    }
  }

  return { table, problems };
};

it('keeps the import table in ADR 0120 equal to the rule import table', () => {
  const adr = readFileSync(
    join(root, 'docs/adr/0120-capability-modules-with-an-enforced-import-table.md'),
    'utf8',
  );

  const parsed = parseImportTable(adr);

  expect(parsed.problems).toEqual([]);
  expect(sortedImportTable(parsed.table)).toEqual(sortedImportTable(importTable));
});

const tableSection = (rows: string[], after: string[] = []) =>
  [
    '### Target modules and import table',
    '',
    '| Module | May import |',
    '| --- | --- |',
    ...rows,
    '',
    ...after,
  ].join('\n');

it.each([
  {
    name: 'a valid table',
    markdown: tableSection(['| `errors` | nothing |', '| `linear` | `command`, `errors` |']),
    problems: [],
  },
  {
    name: 'a duplicated row',
    markdown: tableSection(['| `linear` | `command`, `errors` |', '| `linear` | `errors` |']),
    problems: ['duplicate row: linear'],
  },
  {
    name: 'a plain-text dependency',
    markdown: tableSection(['| `linear` | `command`, errors |']),
    problems: ['malformed dependencies for linear: `command`, errors'],
  },
  {
    name: 'a row after a later heading',
    markdown: tableSection(
      ['| `linear` | `command` |'],
      ['## Consequences', '', '| `errors` | nothing |'],
    ),
    problems: ['row outside the table section: | `errors` | nothing |'],
  },
  {
    name: 'a missing section',
    markdown: '## Decision\n\nNo table here.\n',
    problems: ['missing table section'],
  },
  {
    name: 'a row without a backticked module',
    markdown: tableSection(['| linear | `schema` |']),
    problems: ['malformed row: | linear | `schema` |'],
  },
  {
    name: 'a row without a space after the pipe',
    markdown: tableSection(['|`linear` | `schema` |']),
    problems: ['malformed row: |`linear` | `schema` |'],
  },
  {
    name: 'a row without a closing pipe',
    markdown: tableSection(['| `linear` | nothing']),
    problems: ['malformed row: | `linear` | nothing'],
  },
  {
    name: 'a row with a missing dependency cell',
    markdown: tableSection(['| `linear` |']),
    problems: ['malformed row: | `linear` |'],
  },
])('ADR table check reports problems for $name', ({ markdown, problems }) => {
  expect(parseImportTable(markdown).problems).toEqual(problems);
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
    "import { Value } from 'typebox/value';",
  ].join('\n');

  const schemaLibrary = "import { Value } from 'typebox/value';";

  expect(impurities('src/pure/decide.ts', allowed, registry)).toEqual([]);

  expect(findingLines(impurities('src/pure/decide.ts', refused, registry))).toEqual(
    Array.from({ length: 17 }, (_, index) => index + 1),
  );

  expect(impurities('src/schema.ts', schemaLibrary, registry)).toEqual([]);
});

it('keeps src/ free of index files, one-file folders, and folder modules without an entry', () => {
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
    'src/instructions/coding.md',
    'src/skills/pr/SKILL.md',
    'src/extensions/themes.ts',
    'src/extensions/commit/commit.ts',
    'src/extensions/commit/tool.ts',
    'src/extensions/commit/fixtures/repository.ts',
    'src/extensions/snippets/snippets.ts',
    'src/extensions/snippets/menu.ts',
    'src/extensions/snippets/snippets/verify.md',
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
