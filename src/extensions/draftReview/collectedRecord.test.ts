import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { loadCollectedRecord } from './collectedRecord.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'collected');

const directoryWith = async (fixture: string | undefined) => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-collected-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

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
