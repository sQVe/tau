import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { errorMessage } from '../errors.js';
import { recordFileName } from './record.js';
import { readRecord, requireRecord } from './recordRead.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'records');

const reviewDirectory = async (fixture?: string) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-record-read-');

  if (fixture !== undefined) {
    await writeFile(join(directory, recordFileName), await readFile(join(fixtures, fixture)));
  }

  return directory;
};

const rejection = (outcome: Promise<unknown>) =>
  outcome.then(
    () => undefined,
    (error: unknown) => error,
  );

const thrownBy = (action: () => unknown) => {
  try {
    action();
  } catch (error) {
    return error;
  }

  return undefined;
};

const refusalOf = async (root: string, directory: string) => {
  const result = await readRecord(root, directory);

  return thrownBy(() => requireRecord(result));
};

it('reads a normal record with its parsed record and the Git blob hash of its bytes', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory('version-5.json');
  const path = join(directory, recordFileName);
  const saved = JSON.parse(await readFile(join(fixtures, 'version-5.json'), 'utf8')) as unknown;

  expect(await readRecord(root, directory)).toEqual({
    status: 'read',
    path,
    bytes: await readFile(path),
    record: saved,
    identity: await git(root, 'hash-object', path),
  });
});

it('reports a missing record with the missing file error as its cause', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory();

  expect(await readRecord(root, directory)).toMatchObject({
    status: 'missing',
    path: join(directory, recordFileName),
    cause: { code: 'ENOENT' },
  });
});

it('reports a malformed record as unreadable with the parse error', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory('malformed.json');

  const result = await readRecord(root, directory);

  expect(result).toMatchObject({ status: 'unreadable' });
  expect(errorMessage(thrownBy(() => requireRecord(result)))).toContain('Malformed capture record');
});

it('reports a newer record as unreadable and not as malformed', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory('newer.json');

  const result = await readRecord(root, directory);

  expect(result).toMatchObject({ status: 'unreadable' });
  expect(errorMessage(thrownBy(() => requireRecord(result)))).not.toContain('Malformed');
});

it('refuses to read through a live symlink', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory();
  const outside = temporaryDirectory(onTestFinished, 'tau-record-read-');

  await writeFile(join(outside, recordFileName), await readFile(join(fixtures, 'version-5.json')));
  await symlink(join(outside, recordFileName), join(directory, recordFileName));

  await expect(readRecord(root, directory)).rejects.toThrow('Refusing to read through a symlink');
});

it('refuses to read through a dangling symlink', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory();
  const outside = temporaryDirectory(onTestFinished, 'tau-record-read-');

  await symlink(join(outside, 'missing.json'), join(directory, recordFileName));

  await expect(readRecord(root, directory)).rejects.toThrow('Refusing to read through a symlink');
});

it('refuses to read a record with another hard link', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory();
  const outside = temporaryDirectory(onTestFinished, 'tau-record-read-');

  await writeFile(join(outside, 'shared.json'), await readFile(join(fixtures, 'version-5.json')));
  await link(join(outside, 'shared.json'), join(directory, recordFileName));

  await expect(readRecord(root, directory)).rejects.toThrow(
    'Refusing to read through a file with another hard link',
  );
});

it('rejects a read failure that is not a missing file', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory();

  await mkdir(join(directory, recordFileName));

  const error = await rejection(readRecord(root, directory));

  expect(error).toHaveProperty('code', 'EISDIR');
});

it('keeps the cause when a record is not JSON', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory();

  await writeFile(join(directory, recordFileName), '{"version": 1,');

  const error = await refusalOf(root, directory);

  expect(error).toHaveProperty('cause', expect.any(SyntaxError));
});

it('keeps the cause when a record is missing', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory();

  const error = await refusalOf(root, directory);

  expect(error).toHaveProperty('cause.code', 'ENOENT');
});

it('names the record path when a record is missing', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await reviewDirectory();

  const error = await refusalOf(root, directory);

  expect(errorMessage(error)).toContain(join(directory, recordFileName));
});
