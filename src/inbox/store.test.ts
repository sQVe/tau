import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { deleteHandover, pendingHandovers, publishHandover, readHandover } from './store.js';

const messageId = '11111111-1111-4111-8111-111111111111';

const record = {
  version: 1 as const,
  messageId,
  targetTerminal: 't7',
  targetSessionId: '22222222-2222-4222-8222-222222222222',
  text: 'handover text',
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

  await expect(readHandover(directory, messageId)).resolves.toEqual({ kind: 'record', record });
});

it.each([
  ['newer.json', 'has a newer format than this Tau reads'],
  ['malformed.json', 'Malformed handover record'],
])('reports the frozen record %s as malformed', async (name, reason) => {
  const directory = directoryFixture();

  fixtureInto(directory, name);

  await expect(readHandover(directory, messageId)).resolves.toEqual({
    kind: 'malformed',
    reason: expect.stringContaining(reason) as string,
  });
});

it('reports a missing record', async () => {
  await expect(readHandover(directoryFixture(), messageId)).resolves.toEqual({ kind: 'missing' });
});

it('refuses an oversized record, a symlink, and a directory', async () => {
  const directory = directoryFixture();
  const path = join(directory, `${messageId}.json`);
  const other = '33333333-3333-4333-8333-333333333333';
  const folder = '44444444-4444-4444-8444-444444444444';

  mkdirSync(directory, { recursive: true });
  writeFileSync(path, 'x'.repeat(204_801));
  symlinkSync(path, join(directory, `${other}.json`));
  mkdirSync(join(directory, `${folder}.json`));

  await expect(readHandover(directory, messageId)).resolves.toMatchObject({
    reason: expect.stringContaining('is larger than 204800 bytes') as string,
  });

  await expect(readHandover(directory, other)).resolves.toMatchObject({
    reason: expect.stringContaining('ELOOP') as string,
  });

  await expect(readHandover(directory, folder)).resolves.toMatchObject({
    reason: expect.stringContaining('is not a regular file') as string,
  });
});

it('publishes once and never replaces a saved record', async () => {
  const directory = directoryFixture();
  const path = join(directory, `${messageId}.json`);

  await expect(publishHandover(directory, record)).resolves.toBe('published');

  const saved = readFileSync(path, 'utf8');

  await expect(publishHandover(directory, record)).resolves.toBe('existing');

  await expect(publishHandover(directory, { ...record, text: 'other text' })).resolves.toBe(
    'changed',
  );

  expect(readFileSync(path, 'utf8')).toBe(saved);
});

it('lists saved records by message ID and skips unpublished and foreign names', async () => {
  const directory = directoryFixture();

  await publishHandover(directory, record);
  writeFileSync(join(directory, '.receipt-55555555-5555-4555-8555-555555555555'), '{}');
  writeFileSync(join(directory, 'notes.json'), '{}');

  await expect(pendingHandovers(directory)).resolves.toEqual([messageId]);
  await expect(pendingHandovers(join(directory, 'missing'))).resolves.toEqual([]);
});

it('deletes a record and accepts one that is already gone', async () => {
  const directory = directoryFixture();

  await publishHandover(directory, record);
  await deleteHandover(directory, messageId);
  await deleteHandover(directory, messageId);

  await expect(pendingHandovers(directory)).resolves.toEqual([]);
});
