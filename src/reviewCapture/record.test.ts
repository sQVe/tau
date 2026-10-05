import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { readCaptureRecord, recordFileName, writeCaptureRecord } from './record.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'records');

const reviewDirectory = async (fixture?: string) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-review-record-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  if (fixture !== undefined) {
    await copyFile(join(fixtures, fixture), join(directory, recordFileName));
  }

  return directory;
};

it('reads a version 1 record', async () => {
  const directory = await reviewDirectory('version-1.json');
  const saved = JSON.parse(await readFile(join(fixtures, 'version-1.json'), 'utf8')) as unknown;

  expect(await readCaptureRecord(directory)).toEqual(saved);
});

it('reads back the record it writes', async () => {
  const directory = await reviewDirectory();

  const record = {
    version: 1 as const,
    target: { kind: 'range' as const, from: 'a'.repeat(40), to: 'b'.repeat(40) },
    base: 'a'.repeat(40),
    head: 'c'.repeat(40),
    hash: 'd'.repeat(40),
  };

  await writeCaptureRecord(directory, record);

  expect(await readCaptureRecord(directory)).toEqual(record);
});

it('refuses a missing record', async () => {
  const directory = await reviewDirectory();

  await expect(readCaptureRecord(directory)).rejects.toThrow(join(directory, recordFileName));
});

it.each(['malformed.json', 'newer.json'])('refuses the %s record', async (fixture) => {
  const directory = await reviewDirectory(fixture);

  await expect(readCaptureRecord(directory)).rejects.toThrow(join(directory, recordFileName));
});

it('refuses a saved target revision that is not a full object name and names the field', async () => {
  const directory = await reviewDirectory('option-revision.json');

  await expect(readCaptureRecord(directory)).rejects.toThrow('/target/base');
});

it('refuses a record that is not JSON', async () => {
  const directory = await reviewDirectory();

  await writeFile(join(directory, recordFileName), '{"version": 1,');

  await expect(readCaptureRecord(directory)).rejects.toThrow(join(directory, recordFileName));
});
