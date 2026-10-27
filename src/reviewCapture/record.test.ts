import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { errorMessage } from '../errors.js';
import { readCaptureRecord, recordFileName } from './record.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'records');

const reviewDirectory = async (fixture?: string) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-review-record-');

  if (fixture !== undefined) {
    await copyFile(join(fixtures, fixture), join(directory, recordFileName));
  }

  return directory;
};

const snapshotDirectory = async (directory: string) =>
  Promise.all(
    (await readdir(directory))
      .toSorted()
      .map(async (name) => [name, await readFile(join(directory, name))] as const),
  );

// Reads the record and checks that the read changed no saved file.
const readUnchanged = async (directory: string) => {
  const before = await snapshotDirectory(directory);

  const outcome = await readCaptureRecord(directory).then(
    (record) => ({ record, error: undefined }),
    (error: unknown) => ({
      record: undefined,
      error: error instanceof Error ? error : new Error(errorMessage(error)),
    }),
  );

  expect(await snapshotDirectory(directory)).toEqual(before);

  if (outcome.error !== undefined) {
    throw outcome.error;
  }

  return outcome.record;
};

it('reads a version 1 record', async () => {
  const directory = await reviewDirectory('version-1.json');
  const saved = JSON.parse(await readFile(join(fixtures, 'version-1.json'), 'utf8')) as unknown;

  expect(await readUnchanged(directory)).toEqual(saved);
});

it.each(['version-2.json', 'version-2-fix.json', 'version-3.json', 'version-4.json'])(
  'reads the %s record',
  async (fixture) => {
    const directory = await reviewDirectory(fixture);
    const saved = JSON.parse(await readFile(join(fixtures, fixture), 'utf8')) as unknown;

    expect(await readUnchanged(directory)).toEqual(saved);
  },
);

it('refuses a version 1 record that holds a fix target', async () => {
  const directory = await reviewDirectory();
  const fix = JSON.parse(await readFile(join(fixtures, 'version-2-fix.json'), 'utf8')) as object;

  await writeFile(join(directory, recordFileName), JSON.stringify({ ...fix, version: 1 }));

  await expect(readCaptureRecord(directory)).rejects.toThrow('/target');
});

it('reads a version 2 record', async () => {
  const directory = await reviewDirectory();

  const record = {
    version: 2 as const,
    target: { kind: 'range' as const, from: 'a'.repeat(40), to: 'b'.repeat(40) },
    base: 'a'.repeat(40),
    head: 'c'.repeat(40),
    hash: 'd'.repeat(40),
  };

  await writeFile(join(directory, recordFileName), JSON.stringify(record));

  expect(await readCaptureRecord(directory)).toEqual(record);
});

it('refuses a missing record', async () => {
  const directory = await reviewDirectory();

  await expect(readUnchanged(directory)).rejects.toThrow(join(directory, recordFileName));
});

it.each(['malformed.json', 'newer.json'])('refuses the %s record', async (fixture) => {
  const directory = await reviewDirectory(fixture);

  await expect(readUnchanged(directory)).rejects.toThrow(join(directory, recordFileName));
});

it('refuses a saved target revision that is not a full object name and names the field', async () => {
  const directory = await reviewDirectory('option-revision.json');

  await expect(readUnchanged(directory)).rejects.toThrow('/target/base');
});

it('refuses a record that is not JSON', async () => {
  const directory = await reviewDirectory();

  await writeFile(join(directory, recordFileName), '{"version": 1,');

  await expect(readCaptureRecord(directory)).rejects.toThrow(join(directory, recordFileName));
});

const sha = 'a'.repeat(40);

const savedSnapshot = {
  present: ['src/kept.ts'],
  absent: ['src/gone.ts'],
  skipped: [{ kind: 'binary', path: 'image.png', identity: sha, existed: true }],
};

const savedRecord = (fixture: string) =>
  JSON.parse(readFileSync(join(fixtures, fixture), 'utf8')) as Record<string, unknown>;

const writeRecord = async (directory: string, record: unknown) => {
  await writeFile(join(directory, recordFileName), JSON.stringify(record));
};

const rejection = (outcome: Promise<unknown>) =>
  outcome.then(
    () => undefined,
    (error: unknown) => error,
  );

const refusal = async (record: unknown) => {
  const directory = await reviewDirectory();

  await writeRecord(directory, record);

  const error = await rejection(readCaptureRecord(directory));

  expect(error).toBeInstanceOf(Error);

  return errorMessage(error);
};

it('reads a record that holds a snapshot', async () => {
  const directory = await reviewDirectory();
  const record = { ...savedRecord('version-2-fix.json'), snapshot: savedSnapshot };

  await writeRecord(directory, record);

  expect(await readCaptureRecord(directory)).toEqual(record);
});

describe('refuses a saved record', () => {
  const fix = savedRecord('version-2-fix.json');
  const versionFour = savedRecord('version-4.json');
  const completeEndpoint = versionFour['endpoint'] as Record<string, unknown>;

  const invalidRecords = {
    'with a field it does not define': { ...fix, extra: 1 },
    'of version 1 with a field it does not define': {
      ...savedRecord('version-1.json'),
      extra: 1,
    },
    'with a snapshot field it does not define': {
      ...fix,
      snapshot: { ...savedSnapshot, extra: 1 },
    },
    'with a skipped path field it does not define': {
      ...fix,
      snapshot: { ...savedSnapshot, skipped: [{ ...savedSnapshot.skipped[0], extra: 1 }] },
    },
    'with an empty present path': { ...fix, snapshot: { ...savedSnapshot, present: [''] } },
    'with an empty absent path': { ...fix, snapshot: { ...savedSnapshot, absent: [''] } },
    'with an empty skipped path': {
      ...fix,
      snapshot: { ...savedSnapshot, skipped: [{ ...savedSnapshot.skipped[0], path: '' }] },
    },
    'of version 4 with no endpoint': { ...versionFour, endpoint: undefined },
    'of version 3 with an endpoint': {
      ...savedRecord('version-3.json'),
      endpoint: completeEndpoint,
    },
    'with a complete endpoint that names no ref': {
      ...versionFour,
      endpoint: { ...completeEndpoint, ref: undefined },
    },
    'with a complete endpoint that names no tree': {
      ...versionFour,
      endpoint: { ...completeEndpoint, tree: undefined },
    },
    'with an unsupported endpoint that names no reason': {
      ...versionFour,
      endpoint: { status: 'unsupported', reasons: [] },
    },
  };

  it.each(Object.entries(invalidRecords))('%s', async (_name, record) => {
    const directory = await reviewDirectory();

    await writeRecord(directory, record);

    await expect(readUnchanged(directory)).rejects.toThrow('Malformed capture record');
  });
});

it('refuses a version 3 record that names no original artifact', async () => {
  const directory = await reviewDirectory();
  const record = { ...savedRecord('version-3.json'), original: undefined };

  await writeRecord(directory, record);

  await expect(readUnchanged(directory)).rejects.toThrow('Malformed capture record');
});

it.each(['null', '7', '"text"', '[]'])('refuses the JSON value %s as malformed', async (text) => {
  const directory = await reviewDirectory();

  await writeFile(join(directory, recordFileName), text);

  await expect(readUnchanged(directory)).rejects.toThrow('Malformed capture record');
});

it('names the field of a bad target in a record that is otherwise valid', async () => {
  const record = savedRecord('version-2-fix.json');
  const target = record['target'] as Record<string, unknown>;

  const message = await refusal({ ...record, target: { ...target, base: 'HEAD' } });

  expect(message).toContain('/target/base');
});

it('names the first bad field when the target kind is unknown', async () => {
  const record = savedRecord('version-2-fix.json');

  const message = await refusal({ ...record, target: { kind: 'stash' } });

  expect(message).toContain('Malformed capture record');
  expect(message).not.toContain('/target/base');
});

it('names the record field when only the target is valid', async () => {
  const record = savedRecord('version-2-fix.json');

  const message = await refusal({ ...record, hash: 'short' });

  expect(message).toContain('/hash');
});

it('names a newer record format, not a malformed record', async () => {
  const directory = await reviewDirectory('newer.json');

  const error = await rejection(readUnchanged(directory));

  expect(errorMessage(error)).not.toContain('Malformed');
});

it('does not call a record with a non-number version newer', async () => {
  const message = await refusal({ ...savedRecord('version-2.json'), version: '3' });

  expect(message).toContain('Malformed capture record');
});

it('keeps the cause when a record is not JSON', async () => {
  const directory = await reviewDirectory();

  await writeFile(join(directory, recordFileName), '{"version": 1,');

  const error = await rejection(readCaptureRecord(directory));

  expect(error).toHaveProperty('cause', expect.any(SyntaxError));
});

it('keeps the cause when a record is missing', async () => {
  const directory = await reviewDirectory();

  const error = await rejection(readCaptureRecord(directory));

  expect(error).toHaveProperty('cause.code', 'ENOENT');
});

it('passes on a read failure that is not a missing file', async () => {
  const directory = await reviewDirectory();

  await mkdir(join(directory, recordFileName));

  const error = await rejection(readCaptureRecord(directory));

  expect(error).toHaveProperty('code', 'EISDIR');
});
