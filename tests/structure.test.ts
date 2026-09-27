import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const variants: unknown[] = 'anyOf' in schema ? schema.anyOf : [schema];

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
