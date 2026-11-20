import { existsSync, readFileSync } from 'node:fs';
import { lstat, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { readVersionedRecord, writeRecord } from '../record.ts';
import { readShadowRecords, writeShadowRecord } from './record.ts';
import type { ShadowRecord } from './record.ts';

interface SnapshotEntry {
  name: string;
  kind: 'file' | 'other';
  text: string | undefined;
}

const shadowName = (digit: string): string =>
  `shadow-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}.json`;

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'record', name), 'utf8');

const currentRecord = (): ShadowRecord => JSON.parse(fixture('current.json')) as ShadowRecord;

const snapshot = async (directory: string): Promise<SnapshotEntry[]> => {
  const names = (await readdir(directory)).toSorted();

  return Promise.all(
    names.map(async (name) => {
      const path = join(directory, name);
      const stats = await lstat(path);
      const kind = stats.isFile() ? 'file' : 'other';

      return {
        name,
        kind,
        text: kind === 'file' ? await readFile(path, 'utf8') : undefined,
      };
    }),
  );
};

const shadowDirectory = (onTestFinished: (cleanup: () => void) => void): string =>
  temporaryDirectory(onTestFinished, 'tau-shadow-record-');

it('reads valid shadow records without changing evidence', async ({ onTestFinished }) => {
  const directory = shadowDirectory(onTestFinished);

  await writeFile(join(directory, shadowName('1')), fixture('current.json'));
  await writeFile(join(directory, 'notes.json'), '{"note":"unrelated"}');

  const before = await snapshot(directory);
  const read = await readShadowRecords(directory, readVersionedRecord);
  const after = await snapshot(directory);

  expect(read).toEqual({ records: [currentRecord()], gaps: [] });
  expect(after).toEqual(before);
});

it('returns no records for a missing directory without creating it', async ({ onTestFinished }) => {
  const parent = shadowDirectory(onTestFinished);
  const directory = join(parent, 'missing');

  expect(await readShadowRecords(directory, readVersionedRecord)).toEqual({
    records: [],
    gaps: [],
  });

  expect(existsSync(directory)).toBe(false);
});

it('keeps valid records and names each bad peer as a gap', async ({ onTestFinished }) => {
  const directory = shadowDirectory(onTestFinished);
  const validPath = join(directory, shadowName('1'));
  const malformedPath = join(directory, shadowName('2'));
  const newerPath = join(directory, shadowName('3'));
  const linkedPath = join(directory, shadowName('4'));

  await writeFile(validPath, fixture('current.json'));
  await writeFile(malformedPath, fixture('malformed.json'));
  await writeFile(newerPath, fixture('newer.json'));
  await symlink(validPath, linkedPath);

  const before = await snapshot(directory);
  const { records, gaps } = await readShadowRecords(directory, readVersionedRecord);
  const after = await snapshot(directory);

  expect(records).toEqual([currentRecord()]);
  expect(gaps.map((gap) => gap.path)).toEqual([malformedPath, newerPath, linkedPath]);
  expect(gaps[0]?.reason).toContain(malformedPath);
  expect(gaps[1]?.reason).toContain('newer format');
  expect(gaps[2]?.reason).toContain(linkedPath);
  expect(after).toEqual(before);
});

it('fails a directory read error with its path', async ({ onTestFinished }) => {
  const parent = shadowDirectory(onTestFinished);
  const path = join(parent, 'not-a-directory');

  await writeFile(path, 'plain file');

  await expect(readShadowRecords(path, readVersionedRecord)).rejects.toThrow(path);
});

it('writes concurrent records as distinct complete owner-only files', async ({
  onTestFinished,
}) => {
  const directory = shadowDirectory(onTestFinished);
  const record = currentRecord();

  await Promise.all([
    writeShadowRecord(directory, record, writeRecord),
    writeShadowRecord(directory, record, writeRecord),
  ]);

  const names = (await readdir(directory)).toSorted();

  expect(names).toHaveLength(2);
  expect(new Set(names).size).toBe(2);

  for (const name of names) {
    expect(name).toMatch(/^shadow-[0-9a-f-]{36}\.json$/u);

    const path = join(directory, name);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(record);
  }
});
