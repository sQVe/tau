import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import type { RunRecord } from './records.js';
import { readRunRecord, runRecordPath, writeRunRecord } from './verification.js';

const validRunRecord: RunRecord = {
  version: 1,
  run: 'delegate-a-check',
  target: '482',
  head: '1111111111111111111111111111111111111111',
  dirty: false,
  platform: { os: 'linux', arch: 'x64' },
  startedAt: '2026-11-16T10:00:00.000Z',
  treeAtLaunch: '2222222222222222222222222222222222222222',
  treeAtStop: '3333333333333333333333333333333333333333',
  launch: { exitCode: 0, logPath: 'launch.log' },
  doctor: { exitCode: 0, logPath: 'doctor.log' },
  stop: { exitCode: 0, logPath: 'stop.log' },
  items: [{ item: 'journeys/delegate-a-check', steps: 2 }],
};

const runDirectoryFor = (record: RunRecord, name = record.run): string => {
  const parent = temporaryDirectory(onTestFinished, 'tau-verification-write-');
  const directory = join(parent, name);

  mkdirSync(directory);

  return directory;
};

it('writes a run record that readRunRecord reads back as valid', async () => {
  const directory = runDirectoryFor(validRunRecord);

  await writeRunRecord(directory, validRunRecord);

  expect(await readRunRecord(runRecordPath(directory))).toEqual({
    status: 'valid',
    record: validRunRecord,
  });
});

it('refuses a record whose run differs from its directory name', async () => {
  const directory = runDirectoryFor(validRunRecord, 'other-directory');

  await expect(writeRunRecord(directory, validRunRecord)).rejects.toThrow(/other-directory/u);

  await expect(writeRunRecord(directory, validRunRecord)).rejects.toThrow(/delegate-a-check/u);

  expect(await readRunRecord(runRecordPath(directory))).toEqual({ status: 'missing' });
});

it.each([
  {
    name: 'items that differ only by case',
    record: {
      ...validRunRecord,
      items: [
        { item: 'journeys/delegate-a-check', steps: 2 },
        { item: 'journeys/DELEGATE-A-CHECK', steps: 1 },
      ],
    },
    problem: '/items/1',
  },
  {
    name: 'a non-canonical startedAt',
    record: { ...validRunRecord, startedAt: '2026-11-16T10:00:00Z' },
    problem: '/startedAt is not a canonical timestamp',
  },
  {
    name: 'zero steps for an item',
    record: { ...validRunRecord, items: [{ item: 'journeys/delegate-a-check', steps: 0 }] },
    problem: '/items/0/steps',
  },
])('refuses a record the reader would call malformed: $name', async ({ record, problem }) => {
  const directory = runDirectoryFor(validRunRecord);
  const refusal = `Refusing to write an invalid run record ${runRecordPath(directory)}:`;

  await expect(writeRunRecord(directory, record)).rejects.toThrow(refusal);

  await expect(writeRunRecord(directory, record)).rejects.toThrow(problem);

  expect(await readRunRecord(runRecordPath(directory))).toEqual({ status: 'missing' });
});

it('keeps the earlier record when a later write is refused', async () => {
  const directory = runDirectoryFor(validRunRecord);

  await writeRunRecord(directory, validRunRecord);

  const invalid = { ...validRunRecord, startedAt: '2026-11-16T10:00:00Z' };

  await expect(writeRunRecord(directory, invalid)).rejects.toThrow(/Refusing/u);

  expect(await readRunRecord(runRecordPath(directory))).toEqual({
    status: 'valid',
    record: validRunRecord,
  });
});
