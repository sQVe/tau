import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../../tests/temporaryDirectoryHarness.js';
import { loadCollectedRecord } from './collectedRecord.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'collected');

const directoryWith = async (fixture: string | undefined) => {
  const directory = temporaryDirectory(onTestFinished, 'tau-collected-');

  if (fixture !== undefined) {
    await cp(join(fixtures, fixture), join(directory, 'collected.json'));
  }

  return directory;
};

it('reads a current record', async () => {
  const record = await loadCollectedRecord(await directoryWith('version-1.json'));

  expect(record?.comments[0]).toMatchObject({ id: 'one', deleted: true, content: 'fix this' });
  expect(record?.edits[0]).toMatchObject({ path: 'slices/a.md', status: 'pending' });
});

it('gives undefined when no record was saved', async () => {
  expect(await loadCollectedRecord(await directoryWith(undefined))).toBeUndefined();
});

it('refuses a malformed fixture', async () => {
  await expect(loadCollectedRecord(await directoryWith('malformed.json'))).rejects.toThrow(
    /Malformed collected review/,
  );
});

it('refuses a newer fixture with its own error', async () => {
  await expect(loadCollectedRecord(await directoryWith('newer.json'))).rejects.toThrow(
    /newer format/,
  );
});

it.each([
  { label: 'text that is not JSON', text: '{' },
  { label: 'an unknown field', text: '{"version":1,"comments":[],"edits":[],"x":1}' },
  {
    label: 'an unknown field in a comment',
    text: '{"version":1,"edits":[],"comments":[{"sessionPath":"s","id":"i","deleted":false,"path":"p","startLine":null,"endLine":null,"type":"t","content":"c","x":1}]}',
  },
])('refuses $label', async ({ text }) => {
  const directory = await directoryWith(undefined);

  await writeFile(join(directory, 'collected.json'), text);
  await expect(loadCollectedRecord(directory)).rejects.toThrow(/Malformed collected review/);
});

it('rethrows a read error that is not a missing record', async () => {
  const directory = await directoryWith(undefined);

  await mkdir(join(directory, 'collected.json'));

  await expect(loadCollectedRecord(directory)).rejects.toThrow(/EISDIR/);
});

it.each(['null', '5', '"text"', '{"version":"2","comments":[],"edits":[]}'])(
  'reads a record of %s as malformed, not newer',
  async (text) => {
    const directory = await directoryWith(undefined);

    await writeFile(join(directory, 'collected.json'), text);

    await expect(loadCollectedRecord(directory)).rejects.toThrow(/Malformed collected review/);
  },
);

const comment = {
  sessionPath: 's',
  id: 'i',
  deleted: false,
  path: 'p',
  startLine: null,
  endLine: null,
  type: 't',
  content: 'c',
};

const edit = { path: 'p', diff: 'd', staged: 's', status: 'pending' };

it.each([
  { label: 'an empty session path', comments: [{ ...comment, sessionPath: '' }], edits: [] },
  { label: 'an empty comment id', comments: [{ ...comment, id: '' }], edits: [] },
  { label: 'an empty comment path', comments: [{ ...comment, path: '' }], edits: [] },
  { label: 'an empty edit path', comments: [], edits: [{ ...edit, path: '' }] },
  { label: 'an unknown field in an edit', comments: [], edits: [{ ...edit, x: 1 }] },
])('refuses $label', async ({ comments, edits }) => {
  const directory = await directoryWith(undefined);

  await writeFile(
    join(directory, 'collected.json'),
    JSON.stringify({ version: 1, comments, edits }),
  );

  await expect(loadCollectedRecord(directory)).rejects.toThrow(/Malformed collected review/);
});
