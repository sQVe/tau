import { expect, it } from 'vitest';

import { keepAddedLines, scanMarkers } from './evidenceDecisions.js';

const marked = (name: string) => `${name} @ts-ignore`;

const fileDiff = (path: string, hunks: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n');

const found = (diff: string) => scanMarkers(diff).items.map(({ path, line }) => [path, line]);

it('reads hunk headers whose counts are missing or have several digits', () => {
  const longHunk = [
    '@@ -1,12 +1,13 @@',
    ...Array.from({ length: 12 }, (_value, index) => ` context ${index}`),
    `+${marked('last')}`,
  ];

  expect(found(fileDiff('a.ts', ['@@ -3 +3 @@', '-old', `+${marked('one')}`]))).toEqual([
    ['a.ts', 3],
  ]);

  expect(found(fileDiff('a.ts', ['@@ -3 +3,1 @@', '-old', `+${marked('one')}`]))).toEqual([
    ['a.ts', 3],
  ]);

  expect(found(fileDiff('a.ts', ['@@ -3,1 +3 @@', '-old', `+${marked('one')}`]))).toEqual([
    ['a.ts', 3],
  ]);

  expect(found(fileDiff('a.ts', longHunk))).toEqual([['a.ts', 13]]);
});

it('does not read a line that only contains a hunk header as a hunk', () => {
  const diff = fileDiff('a.ts', ['note @@ -1 +5 @@', `+${marked('x')}`]);

  expect(found(diff)).toEqual([]);
});

it('lists a marker in a file whose name contains a Markdown extension but does not end in one', () => {
  expect(found(fileDiff('docs/a.md.ts', ['@@ -0,0 +1 @@', `+${marked('x')}`]))).toEqual([
    ['docs/a.md.ts', 1],
  ]);
});

it('reads the path of a quoted file header', () => {
  const diff = ['--- a/x', '+++ "b/caf\\303\\251.ts"', '@@ -0,0 +1 @@', `+${marked('x')}`].join(
    '\n',
  );

  expect(found(diff)).toEqual([['café.ts', 1]]);
});

it('reads the path of a quoted file header that a timestamp follows', () => {
  const diff = [
    '--- a/x',
    '+++ "b/caf\\303\\251.ts"\t2020-01-01',
    '@@ -0,0 +1 @@',
    `+${marked('x')}`,
  ];

  expect(found(diff.join('\n'))).toEqual([['café.ts', 1]]);
});

it('lists no marker for the null device', () => {
  const diff = ['--- a/x', '+++ /dev/null', '@@ -1 +1 @@', '-gone', `+${marked('x')}`].join('\n');

  expect(found(diff)).toEqual([]);
});

it('lists no marker before the first file header', () => {
  expect(found(['@@ -1 +1 @@', `+${marked('x')}`].join('\n'))).toEqual([]);
});

it.each([
  { name: 'more added lines', hunk: ['@@ -0,0 +1 @@', '+one', `+${marked('stray')}`] },
  {
    name: 'more added lines after removed lines',
    hunk: ['@@ -1,2 +1 @@', '-a', '-b', '+c', `+${marked('stray')}`],
  },
  {
    name: 'more added lines after context lines',
    hunk: ['@@ -1,2 +1,2 @@', ' a', '-b', '+c', `+${marked('stray')}`],
  },
])('does not read $name than the hunk header counts', ({ hunk }) => {
  expect(found(fileDiff('a.ts', hunk))).toEqual([]);
});

it('skips the no-newline note without counting it as a line', () => {
  const hunk = ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', `+${marked('b')}`];

  expect(found(fileDiff('a.ts', hunk))).toEqual([['a.ts', 1]]);
});

it('starts the next file cleanly after a hunk that ends early', () => {
  const diff = [
    fileDiff('a.ts', ['@@ -1,5 +1,5 @@', ' only line']),
    fileDiff('b.ts', ['@@ -1 +1 @@', '-a', `+${marked('b')}`]),
  ].join('\n');

  expect(found(diff)).toEqual([['b.ts', 1]]);
});

it('keeps the file when a line between two hunks is not part of either', () => {
  const diff = fileDiff('a.ts', [
    '@@ -1 +1 @@',
    '-a',
    '+b',
    'unexpected line',
    '@@ -5 +5 @@',
    '-c',
    `+${marked('d')}`,
  ]);

  expect(found(diff)).toEqual([['a.ts', 5]]);
});

const wholeFile = (lines: string[], header = `@@ -0,0 +1,${lines.length} @@`) =>
  [
    'diff --git a/a.txt b/a.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/a.txt',
    header,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');

it('turns the lines the base already has into context lines', () => {
  const result = keepAddedLines(wholeFile(['a', 'x', 'b']), 'a\nb\n');

  expect(result).toBe(
    [
      'diff --git a/a.txt b/a.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@',
      ' a',
      '+x',
      ' b',
      '',
    ].join('\n'),
  );
});

it('starts the old side at zero when the base shares no line', () => {
  const result = keepAddedLines(wholeFile(['x', 'y']), 'a\n');

  expect(result).toContain('@@ -0,0 +1,2 @@\n+x\n+y\n');
});

it('reads a header without a count and a count with several digits', () => {
  const single = keepAddedLines(wholeFile(['a'], '@@ -0,0 +1 @@'), 'a\n');
  const many = Array.from({ length: 12 }, (_value, index) => `line ${index}`);
  const long = keepAddedLines(wholeFile(many), 'line 0\n');

  expect(single).toContain('@@ -1,1 +1,1 @@\n a\n');
  const addedLines = long.split('\n').filter((line) => line.startsWith('+line'));

  expect(long).toContain('@@ -1,1 +1,12 @@\n line 0\n+line 1\n');
  expect(addedLines).toHaveLength(11);
});

it('leaves the lines after the hunk body as they are', () => {
  const section = `${wholeFile(['a', 'b'])}\\ No newline at end of file\n`;

  const kept = keepAddedLines(section, 'a\n');
  const keepsNote = kept.endsWith('+b\n\\ No newline at end of file\n');

  expect(keepsNote).toBe(true);
});

it('finds the hunk header, not text in an earlier line that looks like one', () => {
  const section = [
    'diff --git a/w @@ -0,0 +1 @@.txt b/w @@ -0,0 +1 @@.txt',
    '--- /dev/null',
    '+++ b/w @@ -0,0 +1 @@.txt',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
    '',
  ].join('\n');

  const result = keepAddedLines(section, 'a\n');

  expect(result).toContain('@@ -1,1 +1,2 @@\n a\n+b\n');
});
