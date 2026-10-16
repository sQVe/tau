import { expect, it } from 'vitest';

import {
  boundList,
  callerText,
  freshnessGaps,
  importPattern,
  importsModule,
  isCaller,
  isSearchable,
  namedPaths,
  numberedBody,
  parseGrepOutput,
  scanMarkers,
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
  { importer: 'src/x/use.ts', text: "import a from '../../a';", module: 'a.ts', imports: true },
  { importer: 'use.ts', text: "import a from '../a.js';", module: 'a.ts', imports: false },
  { importer: 'src/use.ts', text: "import a from '../../a.js';", module: 'a.ts', imports: false },
  {
    importer: 'src/use.ts',
    text: "import a from '../../src/a.js';",
    module: 'src/a.ts',
    imports: false,
  },
  { importer: 'src/use.ts', text: "export * from './x';", module: 'src/x/index.ts', imports: true },
  {
    importer: 'src/use.ts',
    text: "export * from './x.js';",
    module: 'src/x/index.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: "export * from './x.ts';",
    module: 'src/x/index.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: "export * from './x/index.js';",
    module: 'src/x/index.ts',
    imports: true,
  },
  { importer: 'src/use.ts', text: "import a from './x/a.js';", module: 'src/a.ts', imports: false },
  { importer: 'src/use.ts', text: "import a from 'a';", module: 'src/a.ts', imports: false },
  { importer: 'src/use.ts', text: "import './a.js';", module: 'src/a.ts', imports: true },
  { importer: 'src/use.ts', text: "} from './a.js';", module: 'src/a.ts', imports: true },
  { importer: 'src/use.ts', text: "await import('./a.js');", module: 'src/a.ts', imports: true },
  { importer: 'src/use.ts', text: "require('./a.js');", module: 'src/a.ts', imports: true },
  {
    importer: 'src/use.ts',
    text: "export const examplePath = './a.js';",
    module: 'src/a.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: "// import { a } from './a.js';",
    module: 'src/a.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: "  * import a from './a.js';",
    module: 'src/a.ts',
    imports: false,
  },
  { importer: 'src/use.ts', text: "  } from './a.js';", module: 'src/a.ts', imports: true },
  {
    importer: 'src/use.ts',
    text: "export { a } from './a.js';",
    module: 'src/a.ts',
    imports: true,
  },
  {
    importer: 'src/use.ts',
    text: 'const message = "loaded from \'./a.js\'";',
    module: 'src/a.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: "const value = 1; // import a from './a.js'",
    module: 'src/a.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: 'const text = "} from \'./a.js\'";',
    module: 'src/a.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: 'const message = "import \'./a.js\'";',
    module: 'src/a.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: "const slash = /\\//; const a = require('./a.js');",
    module: 'src/a.ts',
    imports: true,
  },
  {
    importer: 'src/use.ts',
    text: "const slash = /\\//; await import('./a.js');",
    module: 'src/a.ts',
    imports: true,
  },
  {
    importer: 'src/use.ts',
    text: "load(); // await import('./a.js');",
    module: 'src/a.ts',
    imports: false,
  },
  {
    importer: 'src/use.ts',
    text: "const url = 'https://a'; await import('./a.js');",
    module: 'src/a.ts',
    imports: true,
  },
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
  { module: 'src/a.ts', searchable: true },
  { module: 'src/new\nline/a.ts', searchable: true },
  { module: 'src/new\nline.ts', searchable: false },
  { module: 'src/new\nline/index.ts', searchable: false },
])('decides that git grep can search for $module: $searchable', ({ module, searchable }) => {
  expect(isSearchable(module)).toBe(searchable);
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
  { text: 'one\ntwo\n', limit: { lines: 5, characters: 50 }, lines: ['one', 'two'], gaps: [] },
  { text: '', limit: { lines: 5, characters: 50 }, lines: [], gaps: [] },
  {
    text: 'one\ntwo\nthree',
    limit: { lines: 2, characters: 50 },
    lines: ['one', 'two'],
    gaps: [{ kind: 'truncatedBody', path: 'a.test.ts', limit: 'lines', kept: 2, total: 3 }],
  },
  { text: 'one\n\ntwo', limit: { lines: 5, characters: 6 }, lines: ['one', '', 'two'], gaps: [] },
  {
    text: 'one\ntwo\nthree',
    limit: { lines: 5, characters: 5 },
    lines: ['one', 'tw'],
    gaps: [{ kind: 'truncatedBody', path: 'a.test.ts', limit: 'characters', kept: 2, total: 3 }],
  },
  {
    text: 'x'.repeat(100),
    limit: { lines: 5, characters: 4 },
    lines: ['xxxx'],
    gaps: [{ kind: 'truncatedBody', path: 'a.test.ts', limit: 'characters', kept: 1, total: 1 }],
  },
  {
    text: 'one\ntwo\nthree',
    limit: { lines: 1, characters: 2 },
    lines: ['on'],
    gaps: [{ kind: 'truncatedBody', path: 'a.test.ts', limit: 'characters', kept: 1, total: 3 }],
  },
])('numbers the body $text with limit $limit', ({ text, limit, lines, gaps }) => {
  expect(numberedBody('a.test.ts', text, limit)).toEqual({
    lines: lines.map((line, index) => ({ line: index + 1, text: line })),
    gaps,
  });
});

it.each([
  { text: 'import a', limit: 8, kept: 'import a', gaps: [] },
  {
    text: 'import a from',
    limit: 8,
    kept: 'import a',
    gaps: [{ kind: 'truncatedLine', path: 'src/use.ts', line: 3, kept: 8, total: 13 }],
  },
])('bounds the caller text $text to $limit characters', ({ text, limit, kept, gaps }) => {
  expect(callerText({ path: 'src/use.ts', line: 3, text }, limit)).toEqual({ text: kept, gaps });
});

const fresh = { status: 'fresh' as const, reasons: [] };
const stale = { status: 'stale' as const, reasons: ['HEAD moved.'] };
const unknown = { status: 'unknown' as const, reasons: ['git diff failed'] };
const mismatch = { kind: 'evidenceMismatch', recordedHash: 'hash-one', evidenceHash: 'hash-two' };

it.each([
  { freshness: fresh, evidenceHash: 'hash-one', gaps: [] },
  { freshness: fresh, evidenceHash: 'hash-two', gaps: [mismatch] },
  {
    freshness: stale,
    evidenceHash: 'hash-one',
    gaps: [{ kind: 'freshness', status: 'stale', reasons: ['HEAD moved.'] }],
  },
  {
    freshness: stale,
    evidenceHash: 'hash-two',
    gaps: [{ kind: 'freshness', status: 'stale', reasons: ['HEAD moved.'] }, mismatch],
  },
  {
    freshness: unknown,
    evidenceHash: 'hash-one',
    gaps: [{ kind: 'freshness', status: 'unknown', reasons: ['git diff failed'] }],
  },
])(
  'turns $freshness.status freshness and evidence hash $evidenceHash into gaps',
  ({ freshness, evidenceHash, gaps }) => {
    expect(freshnessGaps({ freshness, recordedHash: 'hash-one', evidenceHash })).toEqual(gaps);
  },
);

it.each([
  { output: '', revision: undefined, result: { matches: [] } },
  {
    output: 'src/a\nb.ts\u00003\u0000import a from "./a";\n',
    revision: undefined,
    result: { matches: [{ path: 'src/a\nb.ts', line: 3, text: 'import a from "./a";' }] },
  },
  {
    output: `${from}:src/a.ts\u00001\u0000x\n${from}:src/b.ts\u00002\u0000y\n`,
    revision: from,
    result: {
      matches: [
        { path: 'src/a.ts', line: 1, text: 'x' },
        { path: 'src/b.ts', line: 2, text: 'y' },
      ],
    },
  },
  {
    output: 'src/a.mjs\u00002\u0000import a from "./a"; // \u0000\n',
    revision: undefined,
    result: { matches: [{ path: 'src/a.mjs', line: 2, text: 'import a from "./a"; // \u0000' }] },
  },
  {
    output: 'src/a.ts\u0000one\u0000x\n',
    revision: undefined,
    result: { error: 'git grep printed a malformed record: "src/a.ts\\u0000one\\u0000x\\n"' },
  },
  {
    output: 'src/a.ts\u00001\u0000x',
    revision: undefined,
    result: { error: 'git grep printed a malformed record: "src/a.ts\\u00001\\u0000x"' },
  },
  {
    output: 'src/a.ts\u00001\u0000x\n',
    revision: from,
    result: { error: 'git grep printed a malformed record: "src/a.ts\\u00001\\u0000x\\n"' },
  },
])('parses git grep output $output', ({ output, revision, result }) => {
  expect(parseGrepOutput(output, revision)).toEqual(result);
});

const onlySuffix = '.only';
const onlyCall = `it${onlySuffix}('works', () => {});`;

const addedDiff = (path: string, added: string[], context = ''): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${added.length + 1} @@`,
    ` ${context}`,
    ...added.map((line) => `+${line}`),
    '',
  ].join('\n');

it('lists an added marker line with its path and new-side line number', () => {
  const diff = addedDiff('src/a.test.ts', ['plain', `  ${onlyCall}`]);

  expect(scanMarkers(diff)).toEqual({
    items: [{ path: 'src/a.test.ts', line: 3, marker: '.only(', text: `  ${onlyCall}` }],
    gaps: [],
  });
});

it('picks the first marker in list order for a line', () => {
  const diff = addedDiff('a.ts', [`// @ts-ignore ${onlyCall}`]);

  expect(scanMarkers(diff).items.map((item) => item.marker)).toEqual(['.only(']);
});

it.each(['a.md', 'docs/a.MDX', 'b.markdown'])('does not list a marker in %s', (path) => {
  expect(scanMarkers(addedDiff(path, [onlyCall]))).toEqual({ items: [], gaps: [] });
});

it('ignores removed and context lines', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,2 +1,2 @@',
    ` ${onlyCall}`,
    `-${onlyCall}`,
    '+clean',
    '',
  ].join('\n');

  expect(scanMarkers(diff)).toEqual({ items: [], gaps: [] });
});

it('keeps the file when an added line inside a hunk starts with ++', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -0,0 +1,2 @@',
    '+++ b/other.ts',
    `+${onlyCall}`,
    '\\ No newline at end of file',
    '',
  ].join('\n');

  expect(scanMarkers(diff).items).toMatchObject([{ path: 'a.ts', line: 2 }]);
});

it('reads a second hunk and a second file with their own line numbers', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,1 +1,2 @@',
    ' keep',
    `+${onlyCall}`,
    '@@ -10,2 +11,3 @@',
    ' keep',
    ' keep',
    `+${onlyCall}`,
    'diff --git a/b.ts b/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/b.ts',
    '@@ -0,0 +1,1 @@',
    `+${onlyCall}`,
    '',
  ].join('\n');

  expect(scanMarkers(diff).items).toMatchObject([
    { path: 'a.ts', line: 2 },
    { path: 'a.ts', line: 13 },
    { path: 'b.ts', line: 1 },
  ]);
});

it.each([
  { header: '+++ "b/a\\tb.ts"', path: 'a\tb.ts' },
  { header: '+++ "b/emoji😀\\t.ts"', path: 'emoji😀\t.ts' },
  { header: '+++ b/with space.ts\t', path: 'with space.ts' },
])('reads the file name from $header', ({ header, path }) => {
  const diff = ['--- a/x', header, '@@ -0,0 +1,1 @@', `+${onlyCall}`, ''].join('\n');

  expect(scanMarkers(diff).items).toMatchObject([{ path }]);
});

it('lists no marker for a deleted file', () => {
  const diff = ['--- a/a.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', `-${onlyCall}`, ''].join('\n');

  expect(scanMarkers(diff)).toEqual({ items: [], gaps: [] });
});

it('lists no items and no gaps for a diff without markers', () => {
  expect(scanMarkers(addedDiff('a.ts', ['const a = 1;']))).toEqual({ items: [], gaps: [] });
});

it('cuts the list and a long line and reports both', () => {
  const diff = addedDiff('a.ts', [onlyCall, onlyCall, `${onlyCall}${'x'.repeat(50)}`]);
  const result = scanMarkers(diff, { markers: 2, callerLineCharacters: 10 });

  expect(result.items.map((item) => item.text.length)).toEqual([10, 10]);

  expect(result.gaps).toEqual([
    { kind: 'truncatedLine', path: 'a.ts', line: 2, kept: 10, total: onlyCall.length },
    { kind: 'truncatedLine', path: 'a.ts', line: 3, kept: 10, total: onlyCall.length },
    { kind: 'truncatedList', list: 'markers', kept: 2, total: 3 },
  ]);
});
