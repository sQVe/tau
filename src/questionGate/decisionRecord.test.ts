import { existsSync, readFileSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { expect, it } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.ts';
import { readVersionedRecord, writeRecord } from '../record.ts';
import { readDecisionRecords, writeDecisionRecord } from './decisionRecord.ts';
import type { DecisionRecord } from './decisionRecord.ts';

const decisionDirectory = (onTestFinished: (cleanup: () => void) => void): string =>
  temporaryDirectory(onTestFinished, 'tau-decision-record-');

const decisionName = (digit: string): string =>
  `decision-${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}.json`;

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'decisionRecord', name), 'utf8');

const currentRecord = (): DecisionRecord => JSON.parse(fixture('current.json')) as DecisionRecord;

it('reads a written decision record back with its path', async ({ onTestFinished }) => {
  const directory = decisionDirectory(onTestFinished);
  const record = currentRecord();

  const path = await writeDecisionRecord(directory, record, writeRecord);
  const read = await readDecisionRecords(directory, readVersionedRecord);

  expect(basename(path)).toMatch(/^decision-[0-9a-f-]{36}\.json$/u);
  expect(read).toEqual({ records: [{ path, record }], gaps: [] });
});

it('writes the record owner-only', async ({ onTestFinished }) => {
  const directory = decisionDirectory(onTestFinished);
  const record = currentRecord();

  const path = await writeDecisionRecord(directory, record, writeRecord);

  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record);
});

it('reads the current fixture', async ({ onTestFinished }) => {
  const directory = decisionDirectory(onTestFinished);
  const path = join(directory, decisionName('1'));

  await writeFile(path, fixture('current.json'));

  expect(await readDecisionRecords(directory, readVersionedRecord)).toEqual({
    records: [{ path, record: currentRecord() }],
    gaps: [],
  });
});

it('lists nothing for a missing directory', async ({ onTestFinished }) => {
  const parent = decisionDirectory(onTestFinished);
  const directory = join(parent, 'missing');

  expect(await readDecisionRecords(directory, readVersionedRecord)).toEqual({
    records: [],
    gaps: [],
  });

  expect(existsSync(directory)).toBe(false);
});

it('reports a gap for a malformed record and keeps the others', async ({ onTestFinished }) => {
  const directory = decisionDirectory(onTestFinished);
  const validPath = join(directory, decisionName('1'));
  const malformedPath = join(directory, decisionName('2'));

  await writeFile(validPath, fixture('current.json'));
  await writeFile(malformedPath, fixture('malformed.json'));

  const { records, gaps } = await readDecisionRecords(directory, readVersionedRecord);

  expect(records).toEqual([{ path: validPath, record: currentRecord() }]);
  expect(gaps.map((gap) => gap.path)).toEqual([malformedPath]);
  expect(gaps[0]?.reason).toContain(malformedPath);
});

it('reports a gap for a newer record and keeps the others', async ({ onTestFinished }) => {
  const directory = decisionDirectory(onTestFinished);
  const validPath = join(directory, decisionName('1'));
  const newerPath = join(directory, decisionName('2'));

  await writeFile(validPath, fixture('current.json'));
  await writeFile(newerPath, fixture('newer.json'));

  const { records, gaps } = await readDecisionRecords(directory, readVersionedRecord);

  expect(records).toEqual([{ path: validPath, record: currentRecord() }]);
  expect(gaps.map((gap) => gap.path)).toEqual([newerPath]);
  expect(gaps[0]?.reason).toContain('newer format');
});

it('reports a gap when the choice is not the recommended label', async ({ onTestFinished }) => {
  const directory = decisionDirectory(onTestFinished);
  const validPath = join(directory, decisionName('1'));
  const otherChoicePath = join(directory, decisionName('2'));
  const record = currentRecord();

  record.decisions = record.decisions.map((decision) => ({ ...decision, choice: 'Careful' }));

  await writeFile(validPath, fixture('current.json'));
  await writeFile(otherChoicePath, JSON.stringify(record));

  const { records, gaps } = await readDecisionRecords(directory, readVersionedRecord);

  expect(records).toEqual([{ path: validPath, record: currentRecord() }]);
  expect(gaps.map((gap) => gap.path)).toEqual([otherChoicePath]);
  expect(gaps[0]?.reason).toContain('not the recommended option label');
});

it('ignores files that are not decision records', async ({ onTestFinished }) => {
  const directory = decisionDirectory(onTestFinished);
  const path = join(directory, decisionName('1'));
  const shadowFileName = decisionName('2').replace('decision', 'shadow');
  const shadowPath = join(directory, shadowFileName);
  const notesPath = join(directory, 'notes.json');

  await writeFile(path, fixture('current.json'));
  await writeFile(shadowPath, fixture('current.json'));
  await writeFile(notesPath, '{"note":"unrelated"}');

  expect(await readDecisionRecords(directory, readVersionedRecord)).toEqual({
    records: [{ path, record: currentRecord() }],
    gaps: [],
  });
});
