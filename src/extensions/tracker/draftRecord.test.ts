import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { findDraftFor, readDraftRecord } from './draftRecord.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'drafts');

const directoryWith = async (text: string | undefined) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-draft-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  if (text !== undefined) {
    await writeFile(join(directory, 'draft.json'), text);
  }

  return directory;
};

const fixtureText = (name: string) => readFile(join(fixtures, name), 'utf8');

it('reads a current record', async () => {
  const directory = await directoryWith(await fixtureText('version-1.json'));

  expect(await readDraftRecord(directory)).toEqual({
    version: 1,
    identifier: 'ME-600',
    reviewCommentId: 'c1',
  });
});

it('reads a record with no identifier or comment', async () => {
  const directory = await directoryWith('{"version":1,"identifier":null,"reviewCommentId":null}');

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
    text: () => '{"version":1,"identifier":null,"reviewCommentId":null,"x":1}',
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
