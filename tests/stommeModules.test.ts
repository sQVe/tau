import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { importTable, moduleList } from '../lint/rules/moduleBoundaries.ts';

interface ModuleRow {
  name: string;
  entry: string;
  publicFiles: string[];
  imports: string[];
}

const root = join(import.meta.dirname, '..');

const moduleHeadingPattern = /^\[modules\.(?:"([^"]+)"|([A-Za-z0-9_]+))\]$/;

const readString = (section: string, key: string): string => {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(section);

  if (match === null) {
    throw new Error(`stomme.toml module has no ${key}`);
  }

  return match[1] ?? '';
};

const readStringArray = (section: string, key: string): string[] => {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm').exec(section);

  if (match === null) {
    throw new Error(`stomme.toml module has no ${key} array`);
  }

  return [...(match[1] ?? '').matchAll(/"([^"]*)"/g)].map((item) => item[1] ?? '');
};

// Removes TOML comments while keeping a '#' inside a quoted string.
const stripTomlComments = (toml: string): string => {
  let result = '';
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < toml.length; index += 1) {
    const character = toml[index] ?? '';
    const opensQuote = character === '"' || character === "'";

    if (quote === undefined && opensQuote) {
      quote = character;
    } else if (quote === '"' && character === '\\') {
      result += character + (toml[index + 1] ?? '');
      index += 1;

      continue;
    } else if (character === quote) {
      quote = undefined;
    }

    if (quote === undefined && character === '#') {
      while (index < toml.length && toml[index] !== '\n') {
        index += 1;
      }

      result += '\n';

      continue;
    }

    result += character;
  }

  return result;
};

const parseModuleTable = (toml: string): ModuleRow[] => {
  const rows: ModuleRow[] = [];
  const lines = stripTomlComments(toml).split('\n');
  let name: string | undefined;
  let section: string[] = [];

  const finishRow = () => {
    if (name === undefined) {
      return;
    }

    const body = section.join('\n');
    const entry = readString(body, 'entry');
    const publicFiles = readStringArray(body, 'public').toSorted();
    const imports = readStringArray(body, 'imports').toSorted();

    rows.push({ name, entry, publicFiles, imports });
  };

  for (const line of lines) {
    const heading = moduleHeadingPattern.exec(line);

    if (heading !== null) {
      finishRow();
      name = heading[1] ?? heading[2];
      section = [];

      continue;
    }

    if (line.startsWith('[') && name !== undefined) {
      finishRow();
      name = undefined;
      section = [];

      continue;
    }

    if (name !== undefined) {
      section.push(line);
    }
  }

  finishRow();

  return rows;
};

const expectedRows = (): ModuleRow[] =>
  moduleList
    .map((module) => ({
      name: module.name,
      entry: `src/${module.entry}.ts`,
      publicFiles: module.publicFiles.map((file) => `src/${file}.ts`).toSorted(),
      imports: [...(importTable[module.name] ?? [])].toSorted(),
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));

it('ignores a dependency that only appears in a TOML comment', () => {
  const table = parseModuleTable(
    [
      '[modules.commented]',
      'entry = "src/commented/commented.ts"',
      'public = []',
      'imports = [',
      '  "errors",',
      '  # "git",',
      ']',
    ].join('\n'),
  );

  expect(table).toEqual([
    {
      name: 'commented',
      entry: 'src/commented/commented.ts',
      publicFiles: [],
      imports: ['errors'],
    },
  ]);
});

it('keeps the module table in stomme.toml equal to the rule module list', () => {
  const table = parseModuleTable(readFileSync(join(root, 'stomme.toml'), 'utf8'));
  const actualRows = table.toSorted((left, right) => left.name.localeCompare(right.name));

  expect(table).toHaveLength(40);
  expect(actualRows).toEqual(expectedRows());
});
