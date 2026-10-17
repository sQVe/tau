import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, matchesGlob } from 'node:path';
import { promisify } from 'node:util';

import { Minimatch } from 'minimatch';
import { describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import {
  auditScope,
  changedLinesDiffArguments,
  changedScope,
  countedMutants,
  fitCap,
  isProductionFile,
  mergedConfig,
  mutateConfigError,
  mutatePatterns,
  parseCommand,
  rejectedAuditPaths,
  unreportedFiles,
} from './mutationScope.js';

const globs = ['lib/**/*.ts', '!lib/**/*.test.ts', '!lib/**/fixtures/**', '!lib/main.ts'];

const isProduction = (path: string) => isProductionFile(path, globs, matchesGlob);

const diffOf = (path: string, hunks: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n');

describe('isProductionFile', () => {
  it.each([
    { path: 'lib/a.ts', expected: true },
    { path: 'lib/x/y/a.ts', expected: true },
    { path: 'lib/a.test.ts', expected: false },
    { path: 'lib/x/fixtures/f.ts', expected: false },
    { path: 'lib/main.ts', expected: false },
    { path: 'lib/a.md', expected: false },
    { path: 'other/a.ts', expected: false },
  ])('gives $expected for $path', ({ path, expected }) => {
    expect(isProductionFile(path, globs, matchesGlob)).toBe(expected);
  });
});

describe('changedScope', () => {
  it.each([
    { name: 'an empty diff', diff: '', untracked: [] },
    { name: 'a test file', diff: diffOf('lib/a.test.ts', ['@@ -1 +1,2 @@']), untracked: [] },
    { name: 'a fixture', diff: diffOf('lib/x/fixtures/f.ts', ['@@ -1 +1 @@']), untracked: [] },
    {
      name: 'a file outside the globs',
      diff: diffOf('scripts/a.ts', ['@@ -1 +1 @@']),
      untracked: [],
    },
    { name: 'a delete-only hunk', diff: diffOf('lib/a.ts', ['@@ -4,3 +3,0 @@']), untracked: [] },
    {
      name: 'a deleted file',
      diff: ['--- a/lib/a.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n'),
      untracked: [],
    },
    { name: 'an untracked test file', diff: '', untracked: ['lib/a.test.ts'] },
  ])('gives no scope for $name', ({ diff, untracked }) => {
    expect(changedScope(diff, untracked, isProduction)).toEqual([]);
  });

  it.each([
    {
      name: 'a one-line hunk',
      diff: diffOf('lib/a.ts', ['@@ -3 +3 @@']),
      mutate: ['lib/a.ts:3-3'],
    },
    {
      name: 'a multi-line hunk',
      diff: diffOf('lib/a.ts', ['@@ -3,2 +3,4 @@']),
      mutate: ['lib/a.ts:3-6'],
    },
    {
      name: 'several hunks, skipping a delete-only one',
      diff: diffOf('lib/a.ts', ['@@ -3 +3 @@', '@@ -9,2 +8,0 @@', '@@ -20 +19,2 @@']),
      mutate: ['lib/a.ts:3-3', 'lib/a.ts:19-20'],
    },
  ])('lists $name as mutate ranges', ({ diff, mutate }) => {
    expect(changedScope(diff, [], isProduction).flatMap(mutatePatterns)).toEqual(mutate);
  });

  it('adds untracked files whole and sorts by path', () => {
    const diff = diffOf('lib/b.ts', ['@@ -1 +1 @@']);

    const scope = changedScope(diff, ['lib/c.ts', 'lib/a.ts'], isProduction);

    expect(scope.flatMap(mutatePatterns)).toEqual(['lib/a.ts', 'lib/b.ts:1-1', 'lib/c.ts']);
  });
});

describe('auditScope', () => {
  it('keeps production paths once, whole and sorted', () => {
    const scope = auditScope(['lib/b.ts', 'lib/a.ts', 'lib/b.ts', 'lib/a.test.ts'], isProduction);

    expect(scope.flatMap(mutatePatterns)).toEqual(['lib/a.ts', 'lib/b.ts']);
  });

  it('names the paths that are not production code', () => {
    expect(rejectedAuditPaths(['lib/a.ts', 'lib/a.test.ts', 'docs/x.md'], isProduction)).toEqual([
      'lib/a.test.ts',
      'docs/x.md',
    ]);
  });
});

describe('fitCap', () => {
  it.each([
    {
      name: 'everything fits',
      counts: [10, 10],
      cap: 20,
      run: ['a', 'b'],
      unmutated: [],
    },
    {
      name: 'a later file does not fit',
      counts: [10, 11],
      cap: 20,
      run: ['a'],
      unmutated: ['b'],
    },
    {
      name: 'a smaller later file still fits',
      counts: [10, 11, 5],
      cap: 20,
      run: ['a', 'c'],
      unmutated: ['b'],
    },
    {
      name: 'the cap is too small for every file',
      counts: [10, 11],
      cap: 5,
      run: [],
      unmutated: ['a', 'b'],
    },
    {
      name: 'a file has no mutant',
      counts: [0, 3],
      cap: 5,
      run: ['b'],
      unmutated: [],
    },
  ])('splits files when $name', ({ counts, cap, run, unmutated }) => {
    const paths = ['a', 'b', 'c'];
    const input = counts.map((mutants, index) => ({ path: paths[index] ?? '', mutants }));

    expect(fitCap(input, cap)).toEqual({ run, unmutated });
  });
});

describe('changedLinesDiffArguments', () => {
  it('keeps separate hunks whatever the user diff settings say', async () => {
    const root = await createTemporaryRepository(onTestFinished);

    const git = async (...args: string[]) =>
      (await promisify(execFile)('git', args, { cwd: root })).stdout;

    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'lib', 'a.ts'), `${lines.join('\n')}\n`);
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'base');

    lines[1] = 'changed 2';
    lines[9] = 'changed 10';
    await writeFile(join(root, 'lib', 'a.ts'), `${lines.join('\n')}\n`);

    const userSettings = [
      ['diff.interHunkContext', '100'],
      ['diff.noprefix', 'true'],
      ['color.ui', 'always'],
      ['diff.algorithm', 'minimal'],
    ].flatMap(([key, value]) => ['-c', `${key}=${value}`]);

    const diff = await git(...userSettings, ...changedLinesDiffArguments('HEAD'));

    expect(changedScope(diff, [], isProduction).flatMap(mutatePatterns)).toEqual([
      'lib/a.ts:2-2',
      'lib/a.ts:10-10',
    ]);
  });
});

describe('countedMutants', () => {
  it('leaves ignored mutants out of the count', () => {
    expect(countedMutants([{ status: 'Ignored' }, { status: 'Ignored' }])).toBe(0);
    expect(countedMutants([{ status: 'Ignored' }, {}, { status: 'Killed' }])).toBe(2);
  });

  it('gives a file whose mutants are all ignored no cap use', () => {
    const counts = [
      { path: 'a', mutants: countedMutants([{ status: 'Ignored' }]) },
      { path: 'b', mutants: countedMutants([{}, {}]) },
    ];

    expect(fitCap(counts, 2)).toEqual({ run: ['b'], unmutated: [] });
  });
});

describe('parseCommand', () => {
  it.each([
    {
      name: 'changed with a base',
      argv: ['changed', 'main'],
      command: { mode: 'changed', base: 'main', paths: [], maxMutants: 500 },
    },
    {
      name: 'audit with paths, a cap, and a config',
      argv: ['audit', 'a.ts', 'b.ts', '--max-mutants', '7', '--config', 'c.json'],
      command: { mode: 'audit', paths: ['a.ts', 'b.ts'], maxMutants: 7, configPath: 'c.json' },
    },
  ])('parses $name', ({ argv, command }) => {
    expect(parseCommand(argv)).toEqual(command);
  });

  it.each([
    { name: 'a missing base', argv: ['changed'], error: 'changed needs a base' },
    {
      name: 'an extra argument',
      argv: ['changed', 'a', 'b'],
      error: 'changed takes one base only.',
    },
    { name: 'no paths', argv: ['audit'], error: 'audit needs at least one path' },
    { name: 'an unknown mode', argv: ['fix', 'a'], error: 'Unknown mode "fix"' },
    { name: 'no mode', argv: [], error: 'Unknown mode ""' },
    { name: 'a cap of 0', argv: ['changed', 'a', '--max-mutants', '0'], error: 'positive integer' },
    {
      name: 'a cap of -1',
      argv: ['changed', 'a', '--max-mutants', '-1'],
      error: 'positive integer',
    },
    {
      name: 'a cap of 1.5',
      argv: ['changed', 'a', '--max-mutants', '1.5'],
      error: 'positive integer',
    },
    {
      name: 'a cap of abc',
      argv: ['changed', 'a', '--max-mutants', 'abc'],
      error: 'positive integer',
    },
    {
      name: 'an option with no value',
      argv: ['changed', 'a', '--config'],
      error: '--config needs a value.',
    },
  ])('refuses $name', ({ argv, error }) => {
    expect(() => parseCommand(argv)).toThrow(error);
  });
});

describe('changedScope with real Git output', () => {
  it('keeps paths with a space or a non-ASCII character', async () => {
    const root = await createTemporaryRepository(onTestFinished);

    const git = async (...args: string[]) =>
      (await promisify(execFile)('git', args, { cwd: root })).stdout;

    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'lib', 'with space.ts'), 'a\n');
    await writeFile(join(root, 'lib', 'café.ts'), 'a\n');
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'base');
    await writeFile(join(root, 'lib', 'with space.ts'), 'b\n');
    await writeFile(join(root, 'lib', 'café.ts'), 'b\n');

    const diff = await git(...changedLinesDiffArguments('HEAD'));

    expect(changedScope(diff, [], isProduction).flatMap(mutatePatterns)).toEqual([
      'lib/café.ts:1-1',
      'lib/with space.ts:1-1',
    ]);
  });
});

describe('mergedConfig', () => {
  it('turns the break threshold off and keeps the other thresholds', () => {
    const merged = mergedConfig(
      { thresholds: { high: 80, low: 60, break: 100 } },
      ['a.ts'],
      'r.json',
    );

    expect(merged.thresholds).toEqual({ high: 80, low: 60, break: null });
    expect(merged.mutate).toEqual(['a.ts']);
  });

  it('sets the break threshold when the config has none', () => {
    expect(mergedConfig({}, [], 'r.json').thresholds).toEqual({ break: null });
  });
});

describe('mutateConfigError', () => {
  it.each([
    { name: 'no mutate', mutate: undefined, error: 'needs a "mutate" list' },
    { name: 'a mutate that is not a list', mutate: 'src/**', error: 'needs a "mutate" list' },
    { name: 'an empty mutate', mutate: [], error: 'empty "mutate" list' },
    { name: 'only negated globs', mutate: ['!a.ts'], error: 'only "!" globs' },
  ])('refuses $name and names the config', ({ mutate, error }) => {
    const message = mutateConfigError(mutate, 'conf.json');

    expect(message).toContain('conf.json');
    expect(message).toContain(error);
  });

  it('accepts a list with a positive glob', () => {
    expect(mutateConfigError(['a.ts', '!b.ts'], 'conf.json')).toBeUndefined();
  });
});

describe('changedScope with a C-quoted path', () => {
  it('keeps a path with a double quote', async () => {
    const root = await createTemporaryRepository(onTestFinished);

    const git = async (...args: string[]) =>
      (await promisify(execFile)('git', args, { cwd: root })).stdout;

    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'lib', 'q"uote.ts'), 'a\n');
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'base');
    await writeFile(join(root, 'lib', 'q"uote.ts'), 'b\n');

    const diff = await git(...changedLinesDiffArguments('HEAD'));

    expect(changedScope(diff, [], isProduction).flatMap(mutatePatterns)).toEqual([
      'lib/q"uote.ts:1-1',
    ]);
  });
});

describe('changedScope with awkward diffs', () => {
  const changeOf = async (names: string[], edit?: (root: string) => Promise<void>) => {
    const root = await createTemporaryRepository(onTestFinished);

    const git = async (...args: string[]) =>
      (await promisify(execFile)('git', args, { cwd: root })).stdout;

    await mkdir(join(root, 'lib'));

    for (const name of names) {
      await writeFile(join(root, 'lib', name), 'a\n');
    }

    await git('add', '.');
    await git('commit', '--quiet', '-m', 'base');

    for (const name of names) {
      await writeFile(join(root, 'lib', name), 'b\n');
    }

    await edit?.(root);

    return changedScope(await git(...changedLinesDiffArguments('HEAD')), [], isProduction);
  };

  it('keeps a path with a carriage return and a path with an emoji', async () => {
    const scope = await changeOf(['a\rb.ts', 'smile😀.ts']);

    expect(scope.map(({ path }) => path)).toEqual(['lib/a\rb.ts', 'lib/smile😀.ts']);
  });

  it('keeps a later hunk after an added line that starts with "++ "', async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

    const scope = await changeOf(['x.ts'], async (root) => {
      await writeFile(join(root, 'lib', 'p.ts'), `${lines.join('\n')}\n`);
      await promisify(execFile)('git', ['add', '.'], { cwd: root });
      await promisify(execFile)('git', ['commit', '--quiet', '-m', 'p'], { cwd: root });
      lines[1] = '++ plus';
      lines[9] = 'changed 10';
      await writeFile(join(root, 'lib', 'p.ts'), `${lines.join('\n')}\n`);
    });

    expect(scope.flatMap(mutatePatterns)).toEqual(['lib/p.ts:2-2', 'lib/p.ts:10-10']);
  });
});

const match = (pattern: string, file: string) => new Minimatch(pattern).match(file);

describe('glob characters in paths', () => {
  const path = 'lib/[id].js';

  it('selects the literal file in changed mode', () => {
    const [pattern] = mutatePatterns({ path, ranges: [{ start: 3, end: 4 }] });
    const [file] = (pattern ?? '').split(/:(?=\d+-\d+$)/);

    expect(pattern).toBe('lib/[[]id].js:3-4');
    expect(match(file ?? '', path)).toBe(true);
    expect(match(file ?? '', 'lib/i.js')).toBe(false);
  });

  it('selects the literal file in audit mode', () => {
    const [pattern] = mutatePatterns({ path });

    expect(pattern).toBe('lib/[[]id].js');
    expect(match(pattern ?? '', path)).toBe(true);
    expect(match(pattern ?? '', 'lib/i.js')).toBe(false);
  });
});

describe('parseCommand option refusals', () => {
  it.each([
    { name: 'an unknown flag as the base', argv: ['changed', '--name-only'] },
    { name: 'an unknown flag after the base', argv: ['changed', 'main', '--stat'] },
    { name: 'an unknown flag as an audit path', argv: ['audit', '-x'] },
  ])('refuses $name with its own error', ({ argv }) => {
    expect(() => parseCommand(argv)).toThrow('Unknown option');
  });

  it('turns off textconv filters so the diff holds the file text', () => {
    expect(changedLinesDiffArguments('HEAD')).toContain('--no-textconv');
  });

  it('stops Git from reading the base as an option', () => {
    const args = changedLinesDiffArguments('--name-only');

    expect(args.indexOf('--end-of-options')).toBe(args.indexOf('--name-only') - 1);
  });
});

describe('changedScope with an emoji and a quote in the name', () => {
  it('keeps the exact path', async () => {
    const root = await createTemporaryRepository(onTestFinished);

    const git = async (...args: string[]) =>
      (await promisify(execFile)('git', args, { cwd: root })).stdout;

    const name = 'sm😀"ile.ts';

    await mkdir(join(root, 'lib'));
    await writeFile(join(root, 'lib', name), 'a\n');
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'base');
    await writeFile(join(root, 'lib', name), 'b\n');

    const diff = await git(...changedLinesDiffArguments('HEAD'));

    expect(changedScope(diff, [], isProduction).map(({ path }) => path)).toEqual([`lib/${name}`]);
  });
});

describe('unreportedFiles', () => {
  it.each([
    { name: 'every file reported', ran: [['a', 2]], reported: ['a'], expected: [] },
    {
      name: 'a file missing from the report',
      ran: [
        ['a', 2],
        ['b', 1],
      ],
      reported: ['a'],
      expected: ['b'],
    },
    { name: 'a file with no mutants', ran: [['a', 0]], reported: [], expected: [] },
    {
      name: 'nothing reported',
      ran: [
        ['a', 1],
        ['b', 3],
      ],
      reported: [],
      expected: ['a', 'b'],
    },
  ])('lists $expected for $name', ({ ran, reported, expected }) => {
    const input = ran.map(([path, mutants]) => ({ path: String(path), mutants: Number(mutants) }));

    expect(unreportedFiles(input, reported)).toEqual(expected);
  });
});
