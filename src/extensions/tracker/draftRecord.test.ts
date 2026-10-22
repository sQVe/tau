import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { findDraftFor, readDraftRecord, writeDraftField } from './draftRecord.js';

const renameFailure = vi.hoisted(() => ({ error: undefined as Error | undefined }));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    rename: async (...parameters: Parameters<typeof original.rename>) => {
      if (renameFailure.error !== undefined) {
        throw renameFailure.error;
      }

      return original.rename(...parameters);
    },
  };
});

afterEach(() => {
  renameFailure.error = undefined;
});

const fixtures = join(import.meta.dirname, 'fixtures', 'drafts');

const directoryWith = async (text: string | undefined) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-draft-');

  if (text !== undefined) {
    await writeFile(join(directory, 'draft.json'), text);
  }

  return directory;
};

const fixtureText = (name: string) => readFile(join(fixtures, name), 'utf8');

it('reads a previous version 1 record as version 2', async () => {
  const directory = await directoryWith(await fixtureText('version-1.json'));

  expect(await readDraftRecord(directory)).toEqual({
    version: 2,
    identifier: 'ME-600',
    reviewCommentId: 'c1',
    qualityCommentId: null,
  });
});

it('reads a current version 2 record with separate comment IDs', async () => {
  const directory = await directoryWith(await fixtureText('version-2.json'));

  expect(await readDraftRecord(directory)).toEqual({
    version: 2,
    identifier: 'ME-600',
    reviewCommentId: 'c1',
    qualityCommentId: 'q1',
  });
});

it('reads a record with no identifier or comment', async () => {
  const directory = await directoryWith(
    '{"version":2,"identifier":null,"reviewCommentId":null,"qualityCommentId":null}',
  );

  expect((await readDraftRecord(directory))?.identifier).toBeNull();
});

it('gives null when draft.json is missing', async () => {
  expect(await readDraftRecord(await directoryWith(undefined))).toBeNull();
});

const refused = [
  { label: 'a malformed fixture', text: () => fixtureText('malformed.json'), message: /Malformed/ },
  { label: 'a newer fixture', text: () => fixtureText('newer.json'), message: /newer format/ },
  { label: 'text that is not JSON', text: () => '{', message: /not JSON/ },
  {
    label: 'a missing field',
    text: () => '{"version":1,"identifier":null}',
    message: /Malformed/,
  },
  {
    label: 'an extra field',
    text: () =>
      '{"version":2,"identifier":null,"reviewCommentId":null,"qualityCommentId":null,"x":1}',
    message: /Malformed/,
  },
  {
    label: 'an extra field in version 1',
    text: () => '{"version":1,"identifier":null,"reviewCommentId":null,"x":1}',
    message: /Malformed/,
  },
  {
    label: 'an empty quality comment ID',
    text: () => '{"version":2,"identifier":null,"reviewCommentId":null,"qualityCommentId":""}',
    message: /Malformed/,
  },
  {
    label: 'a version 1 record with a quality comment ID',
    text: () => '{"version":1,"identifier":null,"reviewCommentId":null,"qualityCommentId":"q1"}',
    message: /Malformed/,
  },
  {
    label: 'a version 2 record without a quality comment ID',
    text: () => '{"version":2,"identifier":null,"reviewCommentId":null}',
    message: /Malformed/,
  },
  {
    label: 'a wrong type',
    text: () => '{"version":1,"identifier":null,"reviewCommentId":7}',
    message: /Malformed/,
  },
  {
    label: 'an empty comment ID',
    text: () => '{"version":1,"identifier":null,"reviewCommentId":""}',
    message: /Malformed/,
  },
  {
    label: 'a bad identifier',
    text: () => '{"version":1,"identifier":"me-600","reviewCommentId":null}',
    message: /Malformed/,
  },
];

it.each(refused)('refuses $label and names the path', async ({ text, message }) => {
  const directory = await directoryWith(await text());

  await expect(readDraftRecord(directory)).rejects.toThrow(message);
  await expect(readDraftRecord(directory)).rejects.toThrow(join(directory, 'draft.json'));
});

it('throws a read error that is not a missing file', async () => {
  const directory = await directoryWith(undefined);

  await mkdir(join(directory, 'draft.json'));

  await expect(readDraftRecord(directory)).rejects.toMatchObject({ code: 'EISDIR' });
});

it('throws when the tickets path is a plain file', async () => {
  const root = await directoryWith(undefined);

  await mkdir(join(root, '.tau'));
  await writeFile(join(root, '.tau', 'tickets'), 'not a directory\n');

  await expect(findDraftFor(root, 'me-600')).rejects.toMatchObject({ code: 'ENOTDIR' });
  expect(await readFile(join(root, '.tau', 'tickets'), 'utf8')).toBe('not a directory\n');
});

it('finds no draft when the tickets directory does not exist', async () => {
  const root = await directoryWith(undefined);

  expect(await findDraftFor(root, 'me-600')).toMatchObject({ draft: null, malformed: [] });
});

const readJson = async (directory: string) =>
  JSON.parse(await readFile(join(directory, 'draft.json'), 'utf8')) as unknown;

it.each([
  { fixture: 'version-1.json', field: 'identifier', value: 'ME-700' },
  { fixture: 'version-2.json', field: 'reviewCommentId', value: 'c9' },
  { fixture: 'version-2.json', field: 'qualityCommentId', value: 'q9' },
] as const)('sets $field, keeps the rest, and writes version 2', async (input) => {
  const directory = await directoryWith(await fixtureText(input.fixture));
  const before = await readDraftRecord(directory);

  const written = await writeDraftField(directory, input.field, input.value);

  expect(written).toEqual({ ...before, [input.field]: input.value });
  expect(await readJson(directory)).toEqual(written);
  expect(written.version).toBe(2);
});

it('creates draft.json with the other fields null when none exists', async () => {
  const directory = await directoryWith(undefined);

  await writeDraftField(directory, 'qualityCommentId', 'q1');

  expect(await readJson(directory)).toEqual({
    version: 2,
    identifier: null,
    reviewCommentId: null,
    qualityCommentId: 'q1',
  });

  expect(await readdir(directory)).toEqual(['draft.json']);
});

it.each(['malformed.json', 'newer.json'])('refuses to change %s and keeps it', async (fixture) => {
  const text = await fixtureText(fixture);
  const directory = await directoryWith(text);

  await expect(writeDraftField(directory, 'identifier', 'ME-1')).rejects.toThrow(/draft/);

  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(text);
  expect(await readdir(directory)).toEqual(['draft.json']);
});

it.each([
  { field: 'identifier', value: 'me-1' },
  { field: 'identifier', value: '' },
  { field: 'reviewCommentId', value: '' },
  { field: 'qualityCommentId', value: 5 },
  { field: 'reviewCommentId', value: null },
  { field: 'version', value: 'x' },
])('refuses $field value $value and writes nothing', async ({ field, value }) => {
  const missing = await directoryWith(undefined);
  const saved = await directoryWith(await fixtureText('version-1.json'));

  await expect(writeDraftField(missing, field, value)).rejects.toThrow(/field|value/);
  await expect(writeDraftField(saved, field, value)).rejects.toThrow(/field|value/);

  const original = await fixtureText('version-1.json');

  expect(await readdir(missing)).toEqual([]);
  expect(await readFile(join(saved, 'draft.json'), 'utf8')).toBe(original);
});

it('keeps the error, the destination, and the directory when the rename fails', async () => {
  const text = await fixtureText('version-1.json');
  const directory = await directoryWith(text);

  renameFailure.error = new Error('rename failed');

  await expect(writeDraftField(directory, 'identifier', 'ME-1')).rejects.toThrow('rename failed');

  expect(await readdir(directory)).toEqual(['draft.json']);
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(text);
});
