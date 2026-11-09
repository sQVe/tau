import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { deleteMessage, pendingMessages, readMessage, saveMessage } from './store.js';

const messageId = '11111111-1111-4111-8111-111111111111';

const record = {
  version: 1 as const,
  messageId,
  family: 'handover' as const,
  payload: { text: 'handover text' },
};

const directoryFixture = () => join(temporaryDirectory(onTestFinished, 'tau-store-'), 'session');

const fixtureInto = (directory: string, name: string): string => {
  const path = join(directory, `${messageId}.json`);

  mkdirSync(directory, { recursive: true });
  copyFileSync(join(import.meta.dirname, 'fixtures', 'handover', name), path);

  return path;
};

it('reads the frozen current record', async () => {
  const directory = directoryFixture();

  fixtureInto(directory, 'current.json');

  await expect(readMessage(directory, messageId)).resolves.toEqual({ kind: 'record', record });
});

it.each([
  ['newer.json', 'has a newer format than this Tau reads'],
  ['malformed.json', 'Malformed inbox record'],
])('reports the frozen record %s as malformed', async (name, reason) => {
  const directory = directoryFixture();

  fixtureInto(directory, name);

  await expect(readMessage(directory, messageId)).resolves.toEqual({
    kind: 'malformed',
    reason: expect.stringContaining(reason) as string,
  });
});

it('reports a missing record', async () => {
  await expect(readMessage(directoryFixture(), messageId)).resolves.toEqual({ kind: 'missing' });
});

it('refuses an oversized record and a directory', async () => {
  const directory = directoryFixture();
  const path = join(directory, `${messageId}.json`);
  const folder = '44444444-4444-4444-8444-444444444444';

  mkdirSync(directory, { recursive: true });
  writeFileSync(path, 'x'.repeat(204_801));
  mkdirSync(join(directory, `${folder}.json`));

  await expect(readMessage(directory, messageId)).resolves.toMatchObject({
    reason: expect.stringContaining('is larger than 204800 bytes') as string,
  });

  writeFileSync(path, 'x'.repeat(204_800));

  await expect(readMessage(directory, messageId)).resolves.toMatchObject({
    reason: expect.stringContaining('not JSON') as string,
  });

  await expect(readMessage(directory, folder)).resolves.toMatchObject({
    reason: expect.stringContaining('EISDIR') as string,
  });
});

it('saves once and never replaces a saved record', async () => {
  const directory = directoryFixture();
  const path = join(directory, `${messageId}.json`);

  await expect(saveMessage(directory, record)).resolves.toBe('saved');

  const saved = readFileSync(path, 'utf8');

  await expect(saveMessage(directory, record)).resolves.toBe('existing');

  await expect(
    saveMessage(directory, { ...record, payload: { text: 'other text' } }),
  ).resolves.toBe('changed');

  expect(readFileSync(path, 'utf8')).toBe(saved);
});

it('lists saved records by message ID and skips temporary and foreign names', async () => {
  const directory = directoryFixture();

  await saveMessage(directory, record);
  writeFileSync(join(directory, `.${messageId}.json.55555555-5555-4555-8555-555555555555`), '{}');
  writeFileSync(join(directory, 'notes.json'), '{}');

  await expect(pendingMessages(directory)).resolves.toEqual([messageId]);
  await expect(pendingMessages(join(directory, 'missing'))).resolves.toEqual([]);
});

it('deletes a record and accepts one that is already gone', async () => {
  const directory = directoryFixture();

  await saveMessage(directory, record);
  await deleteMessage(directory, messageId);
  await deleteMessage(directory, messageId);

  await expect(pendingMessages(directory)).resolves.toEqual([]);
});
