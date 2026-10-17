import { expect, it } from 'vitest';

import { namedPaths, numberedBody, parseGrepOutput, testPaths } from './evidenceDecisions.js';

it.each([
  { changed: ['package.json'], tests: [], siblings: [] },
  { changed: ['src/a.test.ts.snap'], tests: [], siblings: [] },
  {
    changed: ['src/a.test.mjs', 'src/b.spec.cts'],
    tests: ['src/a.test.mjs', 'src/b.spec.cts'],
    siblings: [],
  },
  { changed: ['src/types.d.mts'], tests: [], siblings: [] },
  { changed: ['src/view.d.tsx'], tests: [], siblings: ['src/view.d.test.tsx'] },
])('picks test files for $changed by their whole extension', ({ changed, tests, siblings }) => {
  expect(testPaths(changed)).toEqual({ changed: tests, siblings });
});

const sections = (rules: string, checks: string) =>
  `# Brief\n\n## Rules\n${rules}\n## Checks\n${checks}`;

it('reads the last line of the last section', () => {
  expect(namedPaths(sections('`a.ts`', '`b.ts`')).checks).toEqual(['b.ts']);
});

it('stops a section at the next heading when it has one line', () => {
  expect(namedPaths(sections('`a.ts`', '`b.ts`')).rules).toEqual(['a.ts']);
});

it('finds a heading with spaces around it and a section that starts on the second line', () => {
  expect(namedPaths('## Rules  \n`a.ts`\n').rules).toEqual(['a.ts']);
  expect(namedPaths('intro\n  ## Checks\n`b.ts`').checks).toEqual(['b.ts']);
});

it('finds nothing when the brief has no such heading', () => {
  expect(namedPaths('`a.ts`\n`b.ts`')).toEqual({ rules: [], checks: [] });
});

it('keeps a path that holds a colon and drops links to other places', () => {
  const links = [
    '`src/a.ts:12`',
    '`https://example.com/guide`',
    '`mailto:me@example.com`',
    '`git+ssh://host/repository`',
    '`x.y-z:rest`',
    '[anchor](#top)',
    '`#top`',
    '[guide](docs/guide.md#usage)',
  ].join('\n');

  expect(namedPaths(sections(links, '')).rules).toEqual(['src/a.ts:12', 'docs/guide.md']);
});

it('cuts a body at the character budget without adding an empty line', () => {
  const body = numberedBody('p.md', 'ab\ncd', { lines: 10, characters: 2 });

  expect(body.lines).toEqual([{ line: 1, text: 'ab' }]);

  expect(body.gaps).toEqual([
    { kind: 'truncatedBody', path: 'p.md', limit: 'characters', kept: 1, total: 2 },
  ]);
});

it('reports no gap for a body with exactly the allowed lines', () => {
  const body = numberedBody('p.md', 'a\nb\n', { lines: 2, characters: 100 });

  expect(body.lines).toHaveLength(2);
  expect(body.gaps).toEqual([]);
});

it.each(['12', '10', '305'])('reads line %s of a grep record', (line) => {
  const output = `src/a.ts\u0000${line}\u0000x\n`;

  expect(parseGrepOutput(output, undefined)).toEqual({
    matches: [{ path: 'src/a.ts', line: Number(line), text: 'x' }],
  });
});

it('reads a record whose path has one character', () => {
  expect(parseGrepOutput('a\u00003\u0000x\n', undefined)).toEqual({
    matches: [{ path: 'a', line: 3, text: 'x' }],
  });
});

it.each([
  { name: 'a zero line number', output: 'a.ts\u00000\u0000x\n' },
  { name: 'a line number with a prefix', output: 'a.ts\u0000x1\u0000x\n' },
  { name: 'a line number with a suffix', output: 'a.ts\u00001x\u0000x\n' },
  { name: 'a line number with a letter after two digits', output: 'a.ts\u000012x\u0000x\n' },
  { name: 'no NUL', output: '7\n\n' },
  { name: 'one NUL', output: 'a\u00005\n' },
])('refuses a grep record with $name', ({ output }) => {
  const result = parseGrepOutput(output, undefined);

  expect(result.error).toContain('malformed record');
  expect(result.matches).toBeUndefined();
});

it('names only the malformed record, not the records before it', () => {
  const output = 'src/ok.ts\u00001\u0000x\nsrc/bad.ts\u0000one\u0000y\n';

  const result = parseGrepOutput(output, undefined);

  expect(result.error).toContain('src/bad.ts');
  expect(result.error).not.toContain('src/ok.ts');
});
