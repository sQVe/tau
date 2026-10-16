import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../tests/gitRepository.js';
import { changedLinesDiffArguments, mutationScope } from './mutationScope.js';

const diffOf = (path: string, hunks: string[]) =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n');

const coreExclude = [
  '**/node_modules/**',
  '**/*.integration.test.ts',
  '**/tau-lint-*/**',
  'src/extensions/**',
];

const extensionExclude = ['**/node_modules/**', '**/*.integration.test.ts', '**/tau-lint-*/**'];

describe('mutationScope', () => {
  it.each([
    { name: 'an empty diff', diff: '' },
    { name: 'a test file', diff: diffOf('src/a.test.ts', ['@@ -1 +1,2 @@']) },
    { name: 'a fixture', diff: diffOf('src/extensions/x/fixtures/f.ts', ['@@ -1 +1 @@']) },
    { name: 'a markdown file', diff: diffOf('src/instructions/coding.md', ['@@ -1 +1 @@']) },
    { name: 'a file outside src', diff: diffOf('scripts/a.ts', ['@@ -1 +1 @@']) },
    { name: 'a delete-only hunk', diff: diffOf('src/a.ts', ['@@ -4,3 +3,0 @@']) },
    {
      name: 'a deleted file',
      diff: ['--- a/src/a.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n'),
    },
  ])('gives no scope for $name', ({ diff }) => {
    expect(mutationScope(diff)).toBeUndefined();
  });

  it.each([
    {
      name: 'a one-line hunk',
      diff: diffOf('src/a.ts', ['@@ -3 +3 @@']),
      mutate: ['src/a.ts:3-3'],
    },
    {
      name: 'a multi-line hunk',
      diff: diffOf('src/a.ts', ['@@ -3,2 +3,4 @@']),
      mutate: ['src/a.ts:3-6'],
    },
    {
      name: 'several hunks, skipping a delete-only one',
      diff: diffOf('src/a.ts', ['@@ -3 +3 @@', '@@ -9,2 +8,0 @@', '@@ -20 +19,2 @@']),
      mutate: ['src/a.ts:3-3', 'src/a.ts:19-20'],
    },
  ])('lists $name as mutate ranges', ({ diff, mutate }) => {
    expect(mutationScope(diff)?.mutate).toEqual(mutate);
  });

  it.each([
    {
      name: 'one extension file',
      paths: ['src/extensions/commit/guard.ts'],
      include: ['src/extensions/commit/**/*.test.ts'],
      exclude: extensionExclude,
    },
    {
      name: 'two extensions',
      paths: ['src/extensions/pr/a.ts', 'src/extensions/commit/b.ts', 'src/extensions/pr/c.ts'],
      include: ['src/extensions/commit/**/*.test.ts', 'src/extensions/pr/**/*.test.ts'],
      exclude: extensionExclude,
    },
    {
      name: 'a core file',
      paths: ['src/errors.ts'],
      include: ['src/**/*.test.ts'],
      exclude: coreExclude,
    },
    {
      name: 'a file directly under src/extensions',
      paths: ['src/extensions/index.ts'],
      include: ['src/**/*.test.ts'],
      exclude: coreExclude,
    },
    {
      name: 'a core file and an extension file',
      paths: ['src/errors.ts', 'src/extensions/commit/guard.ts'],
      include: ['src/**/*.test.ts'],
      exclude: extensionExclude,
    },
  ])('selects tests for $name', ({ paths, include, exclude }) => {
    const diff = paths.map((path) => diffOf(path, ['@@ -1 +1 @@'])).join('\n');
    const scope = mutationScope(diff);

    expect(scope?.include).toEqual(include);
    expect(scope?.exclude).toEqual(exclude);
  });
});

describe('changedLinesDiffArguments', () => {
  it('keeps separate hunks whatever the user diff settings say', async () => {
    const root = await createTemporaryRepository(onTestFinished);

    const git = async (...args: string[]) =>
      (await promisify(execFile)('git', args, { cwd: root })).stdout;

    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);

    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), `${lines.join('\n')}\n`);
    await git('add', '.');
    await git('commit', '--quiet', '-m', 'base');

    lines[1] = 'changed 2';
    lines[9] = 'changed 10';
    await writeFile(join(root, 'src', 'a.ts'), `${lines.join('\n')}\n`);
    await git('commit', '--quiet', '-am', 'head');

    const userSettings = [
      ['diff.interHunkContext', '100'],
      ['diff.noprefix', 'true'],
      ['color.ui', 'always'],
      ['diff.algorithm', 'minimal'],
    ].flatMap(([key, value]) => ['-c', `${key}=${value}`]);

    const diff = await git(...userSettings, ...changedLinesDiffArguments('HEAD^', 'HEAD'));

    expect(mutationScope(diff)?.mutate).toEqual(['src/a.ts:2-2', 'src/a.ts:10-10']);
  });
});
