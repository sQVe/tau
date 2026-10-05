import { expect, it } from 'vitest';

import {
  boundList,
  freshnessGaps,
  importPattern,
  importsModule,
  isCaller,
  namedPaths,
  numberedBody,
  sourceRevision,
  testPaths,
} from './evidenceDecisions.js';

const from = 'a'.repeat(40);
const to = 'b'.repeat(40);

it.each([
  { target: { kind: 'range' as const, from, to }, revision: to },
  { target: { kind: 'rootCommit' as const, commit: from }, revision: from },
  { target: { kind: 'workingTree' as const, base: from }, revision: undefined },
  { target: { kind: 'files' as const, paths: ['a.ts'], base: from }, revision: undefined },
])('reads a $target.kind target at $revision', ({ target, revision }) => {
  expect(sourceRevision(target)).toBe(revision);
});

it.each([
  { changed: ['src/a.ts'], tests: [], siblings: ['src/a.test.ts'] },
  { changed: ['src/a.ts', 'src/a.test.ts'], tests: ['src/a.test.ts'], siblings: [] },
  { changed: ['src/b.spec.tsx'], tests: ['src/b.spec.tsx'], siblings: [] },
  { changed: ['src/types.d.ts', 'README.md'], tests: [], siblings: [] },
  { changed: ['lib/c.mjs'], tests: [], siblings: ['lib/c.test.mjs'] },
])('picks test files for $changed', ({ changed, tests, siblings }) => {
  expect(testPaths(changed)).toEqual({ changed: tests, siblings });
});

it.each([
  {
    importer: 'src/use.ts',
    text: "import { a } from './a.js';",
    module: 'src/a.ts',
    imports: true,
  },
  { importer: 'src/x/use.ts', text: "import a from '../a';", module: 'src/a.ts', imports: true },
  { importer: 'src/use.ts', text: "export * from './x';", module: 'src/x/index.ts', imports: true },
  { importer: 'src/use.ts', text: "import a from './x/a.js';", module: 'src/a.ts', imports: false },
  { importer: 'src/use.ts', text: "import a from 'a';", module: 'src/a.ts', imports: false },
  {
    importer: 'src/use.ts',
    text: "import b from './b.js'; import a from './a.js';",
    module: 'src/a.ts',
    imports: true,
  },
])('decides that $importer line "$text" imports $module: $imports', (row) => {
  expect(importsModule(row.importer, row.text, row.module)).toBe(row.imports);
});

it.each([
  { importer: 'src/use.ts', caller: true },
  { importer: 'src/a.ts', caller: false },
  { importer: 'src/use.test.ts', caller: false },
  { importer: 'docs/use.md', caller: false },
])('decides that $importer calls src/a.ts: $caller', ({ importer, caller }) => {
  expect(isCaller(importer, 'src/a.ts')).toBe(caller);
});

it.each([
  { module: 'src/a.ts', line: "import a from './a.js';", matches: true },
  { module: 'src/a.ts', line: "import a from './ab.js';", matches: false },
  { module: 'src/x/index.ts', line: "import a from '../x';", matches: true },
  { module: 'src/a+b.ts', line: "import a from './a+b';", matches: true },
])('matches $line for $module with the grep pattern: $matches', ({ module, line, matches }) => {
  // POSIX extended patterns and JavaScript agree on the syntax importPattern uses.
  expect(new RegExp(importPattern(module)).test(line)).toBe(matches);
});

it.each([
  {
    input: '## Rules\n\n- `AGENTS.md`\n- [ADR](docs/adr/1.md#context)\n\n## Checks\n\nnone\n',
    rules: ['AGENTS.md', 'docs/adr/1.md'],
    checks: [],
  },
  {
    input: '## Rules\n\nRun `pnpm check` and read <https://example.com>.\n\n## Capture\n',
    rules: [],
    checks: [],
  },
  {
    input: '## Checks\n\n`/tmp/check.log` and `/tmp/check.log`\n\n## Capture\n`AGENTS.md`\n',
    rules: [],
    checks: ['/tmp/check.log'],
  },
  { input: '', rules: [], checks: [] },
])('names rule paths $rules and check paths $checks', ({ input, rules, checks }) => {
  expect(namedPaths(input)).toEqual({ rules, checks });
});

it.each([
  { items: [1, 2], limit: 2, kept: [1, 2], gaps: [] },
  {
    items: [1, 2, 3],
    limit: 2,
    kept: [1, 2],
    gaps: [{ kind: 'truncatedList', list: 'callers', path: 'src/a.ts', kept: 2, total: 3 }],
  },
])('bounds $items to $limit', ({ items, limit, kept, gaps }) => {
  expect(boundList(items, limit, { list: 'callers', path: 'src/a.ts' })).toEqual({
    items: kept,
    gaps,
  });
});

it.each([
  { text: 'one\ntwo\n', limit: 5, lines: ['one', 'two'], gaps: [] },
  { text: '', limit: 5, lines: [], gaps: [] },
  {
    text: 'one\ntwo\nthree',
    limit: 2,
    lines: ['one', 'two'],
    gaps: [{ kind: 'truncatedBody', path: 'a.test.ts', kept: 2, total: 3 }],
  },
])('numbers the body $text with limit $limit', ({ text, limit, lines, gaps }) => {
  expect(numberedBody('a.test.ts', text, limit)).toEqual({
    lines: lines.map((line, index) => ({ line: index + 1, text: line })),
    gaps,
  });
});

it.each([
  { freshness: { status: 'fresh' as const, reasons: [] }, gaps: [] },
  {
    freshness: { status: 'stale' as const, reasons: ['HEAD moved.'] },
    gaps: [{ kind: 'freshness', status: 'stale', reasons: ['HEAD moved.'] }],
  },
  {
    freshness: { status: 'unknown' as const, reasons: ['git diff failed'] },
    gaps: [{ kind: 'freshness', status: 'unknown', reasons: ['git diff failed'] }],
  },
])('turns $freshness.status freshness into gaps', ({ freshness, gaps }) => {
  expect(freshnessGaps(freshness)).toEqual(gaps);
});
