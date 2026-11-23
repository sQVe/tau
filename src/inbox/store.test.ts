import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { deleteMessage, pendingMessages, readMessage, saveMessage } from './store.js';

const messageId = '11111111-1111-4111-8111-111111111111';

const sender = { terminal: 'lead', sessionId: '22222222-2222-4222-8222-222222222222' };

const record = {
  version: 3 as const,
  messageId,
  family: 'handover' as const,
  payload: { text: 'handover text', sender },
};

const version2Record = {
  version: 2 as const,
  messageId,
  family: 'handover' as const,
  payload: { text: 'handover text', sender },
};

const currentRecord = {
  version: 3 as const,
  messageId,
  family: 'handover-question' as const,
  payload: {
    questionId: '33333333-3333-4333-8333-333333333333',
    text: 'Which option should I use?',
    askerTerminal: 'worker',
    askerSession: '44444444-4444-4444-8444-444444444444',
  },
};

const previousRecord = {
  version: 1 as const,
  messageId,
  family: 'handover' as const,
  payload: { text: 'handover text' },
};

const previousAnswerRecord = {
  version: 1 as const,
  messageId,
  family: 'answer' as const,
  payload: {
    assignmentId: '22222222-2222-4222-8222-222222222222',
    questionId: '33333333-3333-4333-8333-333333333333',
    parentSession: 'lead-session',
    answer: 'Use 42.',
  },
};

const directoryFixture = () => join(temporaryDirectory(onTestFinished, 'tau-store-'), 'session');

const fixtureInto = (directory: string, name: string): string => {
  const path = join(directory, `${messageId}.json`);

  mkdirSync(directory, { recursive: true });
  copyFileSync(join(import.meta.dirname, 'fixtures', 'handover', name), path);

  return path;
};

it('reads the frozen previous record', async () => {
  const directory = directoryFixture();

  fixtureInto(directory, 'previous.json');

  await expect(readMessage(directory, messageId)).resolves.toEqual({
    kind: 'record',
    record: previousRecord,
  });
});

it('reads the frozen previous answer record', async () => {
  const directory = directoryFixture();

  fixtureInto(directory, 'previousAnswer.json');

  await expect(readMessage(directory, messageId)).resolves.toEqual({
    kind: 'record',
    record: previousAnswerRecord,
  });
});

it('reads the frozen version 2 record', async () => {
  const directory = directoryFixture();

  fixtureInto(directory, 'version2.json');

  await expect(readMessage(directory, messageId)).resolves.toEqual({
    kind: 'record',
    record: version2Record,
  });
});

it('reads the frozen current record', async () => {
  const directory = directoryFixture();

  fixtureInto(directory, 'current.json');

  await expect(readMessage(directory, messageId)).resolves.toEqual({
    kind: 'record',
    record: currentRecord,
  });
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

it('reports a version 1 record with a sender as malformed', async () => {
  const directory = directoryFixture();
  const path = join(directory, `${messageId}.json`);

  mkdirSync(directory, { recursive: true });

  writeFileSync(
    path,
    JSON.stringify({ ...previousRecord, payload: { text: 'handover text', sender } }),
  );

  await expect(readMessage(directory, messageId)).resolves.toMatchObject({ kind: 'malformed' });
});

it('reports a version 2 record with the handover-question family as malformed', async () => {
  const directory = directoryFixture();
  const path = join(directory, `${messageId}.json`);

  mkdirSync(directory, { recursive: true });

  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      messageId,
      family: 'handover-question',
      payload: currentRecord.payload,
    }),
  );

  await expect(readMessage(directory, messageId)).resolves.toMatchObject({ kind: 'malformed' });
});

it('reports a saved answer-request record as malformed', async () => {
  const directory = directoryFixture();
  const path = join(directory, `${messageId}.json`);

  mkdirSync(directory, { recursive: true });

  for (const version of [1, 2, 3]) {
    writeFileSync(
      path,
      JSON.stringify({
        version,
        messageId,
        family: 'answer-request',
        payload: {
          assignmentId: '22222222-2222-4222-8222-222222222222',
          questionId: '33333333-3333-4333-8333-333333333333',
          answer: 'Use 42.',
        },
      }),
    );

    await expect(readMessage(directory, messageId)).resolves.toMatchObject({ kind: 'malformed' });
  }
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
    saveMessage(directory, { ...record, payload: { ...record.payload, text: 'other text' } }),
  ).resolves.toBe('changed');

  expect(readFileSync(path, 'utf8')).toBe(saved);
});

it('keeps a pending version 1 record when the same message is saved again', async () => {
  const directory = directoryFixture();
  const path = fixtureInto(directory, 'previous.json');
  const saved = readFileSync(path, 'utf8');

  await expect(
    saveMessage(directory, { ...record, payload: previousRecord.payload }),
  ).resolves.toBe('existing');

  expect(readFileSync(path, 'utf8')).toBe(saved);
});

it('reports a retry whose sender differs from a pending version 1 record as changed', async () => {
  const directory = directoryFixture();

  fixtureInto(directory, 'previous.json');

  await expect(saveMessage(directory, record)).resolves.toBe('changed');
});

it('reports a pending record with a different message ID as changed', async () => {
  const directory = directoryFixture();
  const otherMessageId = '33333333-3333-4333-8333-333333333333';

  mkdirSync(directory, { recursive: true });

  writeFileSync(
    join(directory, `${messageId}.json`),
    JSON.stringify({ ...record, messageId: otherMessageId }),
  );

  await expect(saveMessage(directory, record)).resolves.toBe('changed');
});

it('reports a pending record with a different family as changed', async () => {
  const directory = directoryFixture();

  mkdirSync(directory, { recursive: true });

  writeFileSync(
    join(directory, `${messageId}.json`),
    JSON.stringify({
      version: 2,
      messageId,
      family: 'answer',
      payload: {
        assignmentId: '33333333-3333-4333-8333-333333333333',
        questionId: '44444444-4444-4444-8444-444444444444',
        parentSession: 'lead-session',
        answer: 'Use 42.',
      },
    }),
  );

  await expect(saveMessage(directory, record)).resolves.toBe('changed');
});

it('reports a retry over a saved entry that is not a record as changed', async () => {
  const directory = directoryFixture();

  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${messageId}.json`), 'not JSON\n');

  await expect(saveMessage(directory, record)).resolves.toBe('changed');
});

it('writes nothing when the fence gives a reason', async () => {
  const directory = directoryFixture();

  await expect(
    saveMessage(directory, record, { fence: { check: () => 'Not now.' } }),
  ).resolves.toEqual({
    refused: 'Not now.',
  });

  await expect(pendingMessages(directory)).resolves.toEqual([]);
});

it('does not run the fence for a message that is already saved', async () => {
  const directory = directoryFixture();

  await saveMessage(directory, record);

  await expect(
    saveMessage(directory, record, { fence: { check: () => 'Not now.' } }),
  ).resolves.toBe('existing');
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
