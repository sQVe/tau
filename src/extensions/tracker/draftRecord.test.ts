import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { findDraftFor, readDraftRecord, writeDraftRecord } from './draftRecord.js';
import type { DraftRecord } from './draftRecord.js';

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

it('reads a previous version 1 record as version 3', async () => {
  const directory = await directoryWith(await fixtureText('version-1.json'));

  expect(await readDraftRecord(directory)).toEqual({
    version: 3,
    identifier: 'ME-600',
    comments: { '# Code review: ME-600': 'c1' },
  });
});

it('reads a previous version 2 record with heading keys', async () => {
  const directory = await directoryWith(await fixtureText('version-2.json'));

  expect(await readDraftRecord(directory)).toEqual({
    version: 3,
    identifier: 'ME-600',
    comments: { '# Code review: ME-600': 'c1', '# Code quality: ME-600': 'q1' },
  });
});

it.each([
  { version: 1, comments: { '# Code review: ME-869': 'review' } },
  {
    version: 2,
    comments: { '# Code review: ME-869': 'review', '# Code quality: ME-869': 'quality' },
  },
])(
  'preserves unbound version $version comments in an identifier directory',
  async ({ version, comments }) => {
    const root = await directoryWith(undefined);
    const directory = join(root, 'me-869');
    const text = await fixtureText(`version-${version}-unbound.json`);
    await mkdir(directory);
    await writeFile(join(directory, 'draft.json'), text);

    expect(await readDraftRecord(directory)).toEqual({ version: 3, identifier: null, comments });
    expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(text);
  },
);

it('reads the current version 3 fixture without changing it', async () => {
  const text = await fixtureText('version-3.json');
  const directory = await directoryWith(text);

  expect(await readDraftRecord(directory)).toEqual(JSON.parse(text));
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(text);
});

it.each([1, 2])('drops comment IDs from version %s without an identifier', async (version) => {
  const record = {
    version,
    identifier: null,
    reviewCommentId: 'review',
    ...(version === 2 ? { qualityCommentId: 'quality' } : {}),
  };

  const text = JSON.stringify(record);
  const directory = await directoryWith(text);

  expect(await readDraftRecord(directory)).toEqual({ version: 3, identifier: null, comments: {} });
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(text);
});

it.each([
  { label: 'version 1', version: 1, reviewCommentId: null, expected: {} },
  {
    label: 'version 2 both absent',
    version: 2,
    reviewCommentId: null,
    qualityCommentId: null,
    expected: {},
  },
  {
    label: 'version 2 no quality',
    version: 2,
    reviewCommentId: 'review',
    qualityCommentId: null,
    expected: { '# Code review: ME-600': 'review' },
  },
  {
    label: 'version 2 no review',
    version: 2,
    reviewCommentId: null,
    qualityCommentId: 'quality',
    expected: { '# Code quality: ME-600': 'quality' },
  },
])('omits absent legacy comment IDs: $label', async ({ label: _label, expected, ...record }) => {
  const text = JSON.stringify({ ...record, identifier: 'ME-600' });
  const directory = await directoryWith(text);

  expect(await readDraftRecord(directory)).toEqual({
    version: 3,
    identifier: 'ME-600',
    comments: expected,
  });

  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(text);
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

const replacement: DraftRecord = { version: 3, identifier: 'ME-1', comments: { '# Report': 'c1' } };

it.each(['version-1.json', 'version-2.json', 'version-3.json'])(
  'writes a version 3 record over %s',
  async (fixture) => {
    const directory = await directoryWith(await fixtureText(fixture));

    await writeDraftRecord(directory, replacement);

    expect(await readJson(directory)).toEqual(replacement);
    expect(await readdir(directory)).toEqual(['draft.json']);
  },
);

it('creates draft.json when none exists', async () => {
  const directory = await directoryWith(undefined);

  await writeDraftRecord(directory, replacement);

  expect(await readJson(directory)).toEqual(replacement);
  expect(await readdir(directory)).toEqual(['draft.json']);
});

it.each(['malformed.json', 'newer.json'])('refuses to change %s and keeps it', async (fixture) => {
  const text = await fixtureText(fixture);
  const directory = await directoryWith(text);

  await expect(writeDraftRecord(directory, replacement)).rejects.toThrow(/draft/);

  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(text);
  expect(await readdir(directory)).toEqual(['draft.json']);
});

it.each([
  { identifier: 'me-1' },
  { identifier: '' },
  { comments: { '# Report': '' } },
  { comments: { '# Report': 5 } },
  { comments: { '# Report': null } },
  { version: 2 },
])('refuses invalid record %j and writes nothing', async (invalid) => {
  const missing = await directoryWith(undefined);
  const saved = await directoryWith(await fixtureText('version-1.json'));
  const record = { ...replacement, ...invalid } as DraftRecord;

  await expect(writeDraftRecord(missing, record)).rejects.toThrow(/Invalid ticket draft/);
  await expect(writeDraftRecord(saved, record)).rejects.toThrow(/Invalid ticket draft/);

  const original = await fixtureText('version-1.json');

  expect(await readdir(missing)).toEqual([]);
  expect(await readFile(join(saved, 'draft.json'), 'utf8')).toBe(original);
});

it('keeps the error, the destination, and the directory when the rename fails', async () => {
  const text = await fixtureText('version-1.json');
  const directory = await directoryWith(text);

  renameFailure.error = new Error('rename failed');

  await expect(writeDraftRecord(directory, replacement)).rejects.toThrow('rename failed');

  expect(await readdir(directory)).toEqual(['draft.json']);
  expect(await readFile(join(directory, 'draft.json'), 'utf8')).toBe(text);
});
