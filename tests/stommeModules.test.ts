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

const parseModuleTable = (toml: string): ModuleRow[] => {
  const rows: ModuleRow[] = [];
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

  for (const line of toml.split('\n')) {
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

it('keeps the module table in stomme.toml equal to the rule module list', () => {
  const table = parseModuleTable(readFileSync(join(root, 'stomme.toml'), 'utf8'));
  const actualRows = table.toSorted((left, right) => left.name.localeCompare(right.name));

  expect(table).toHaveLength(31);
  expect(actualRows).toEqual(expectedRows());
});
