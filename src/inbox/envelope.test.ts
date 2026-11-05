import { copyFile, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { serializeRecord } from '../record.js';
import { ensureTauDirectory } from '../tauDirectory.js';
import { readEnvelope } from './envelope.js';
import type { InboxEnvelope } from './envelope.js';

const fixtures = join(import.meta.dirname, 'fixtures');

const envelope: InboxEnvelope = {
  version: 2,
  messageId: 'm1',
  targetTerminal: 't7',
  targetSessionId: 'session-1',
  family: 'handover',
  text: 'Next steps\n',
};

const repositoryWithFile = async (content: string, fileName: string) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = join(directory, fileName);

  await writeFile(path, content);

  return { root, path };
};

const repositoryWithFixture = async (fixture: string, fileName: string) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = join(directory, fileName);

  await copyFile(join(fixtures, fixture), path);

  return { root, path };
};

it('reads a valid envelope', async () => {
  const { path } = await repositoryWithFile(serializeRecord(envelope), 'm1.json');

  await expect(readEnvelope(path, { messageId: 'm1', terminal: 't7' })).resolves.toEqual({
    kind: 'valid',
    envelope,
  });
});

it('refuses a missing envelope', async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await ensureTauDirectory(root, 'inbox');

  const path = join(root, '.tau', 'inbox', 'missing.json');
  const result = await readEnvelope(path, { messageId: 'missing', terminal: 't7' });

  expect(result.kind).toBe('refused');
});

it('refuses a path outside .tau/inbox', async () => {
  const { path } = await repositoryWithFile(serializeRecord(envelope), 'm1.json');
  const outside = join(path, '..', '..', '..', 'm1.json');

  const result = await readEnvelope(outside, { messageId: 'm1', terminal: 't7' });

  expect(result.kind).toBe('refused');
});

it('refuses an id mismatch between the filename and the expected id', async () => {
  const { path } = await repositoryWithFile(serializeRecord(envelope), 'm1.json');
  const result = await readEnvelope(path, { messageId: 'other', terminal: 't7' });

  expect(result.kind).toBe('refused');
});

it('refuses an id mismatch between the filename and the envelope', async () => {
  const { path } = await repositoryWithFile(serializeRecord(envelope), 'other.json');
  const result = await readEnvelope(path, { messageId: 'other', terminal: 't7' });

  expect(result.kind).toBe('refused');
});

it('refuses another target terminal', async () => {
  const { path } = await repositoryWithFile(serializeRecord(envelope), 'm1.json');
  const result = await readEnvelope(path, { messageId: 'm1', terminal: 't8' });

  expect(result.kind).toBe('refused');
});

it('reads a session ID at the length limit', async () => {
  const sessionId = 's'.repeat(500);

  const { path } = await repositoryWithFile(
    serializeRecord({ ...envelope, targetSessionId: sessionId }),
    'm1.json',
  );

  await expect(readEnvelope(path, { messageId: 'm1', terminal: 't7' })).resolves.toMatchObject({
    kind: 'valid',
    envelope: { targetSessionId: sessionId },
  });
});

it('refuses a session ID over the length limit', async () => {
  const { path } = await repositoryWithFile(
    serializeRecord({ ...envelope, targetSessionId: 's'.repeat(501) }),
    'm1.json',
  );

  await expect(readEnvelope(path, { messageId: 'm1', terminal: 't7' })).resolves.toMatchObject({
    kind: 'refused',
  });
});

it.each([
  { case: 'a file that is not JSON', fileName: 'm1.txt', messageId: 'm1' },
  { case: 'an empty message id', fileName: '.json', messageId: '' },
  { case: 'a nested file name', fileName: 'nested/m1.json', messageId: 'nested' },
])('refuses $case inside .tau/inbox', async ({ fileName, messageId }) => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');
  const path = join(directory, fileName);

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeRecord(envelope));

  const result = await readEnvelope(path, { messageId, terminal: 't7' });

  expect(result.kind).toBe('refused');
});

it('reads the current fixture as an answer envelope', async () => {
  const { path } = await repositoryWithFixture('current.json', 'current-message.json');

  await expect(
    readEnvelope(path, { messageId: 'current-message', terminal: 't7' }),
  ).resolves.toMatchObject({ kind: 'valid', envelope: { version: 2, family: 'answer' } });
});

it('reads the version 1 fixture as a version 2 handover', async () => {
  const { path } = await repositoryWithFixture('v1.json', 'current-message.json');

  await expect(
    readEnvelope(path, { messageId: 'current-message', terminal: 't7' }),
  ).resolves.toEqual({
    kind: 'valid',
    envelope: {
      version: 2,
      messageId: 'current-message',
      targetTerminal: 't7',
      targetSessionId: 'session-1',
      family: 'handover',
      text: 'Next steps\n',
    },
  });
});

it.each([
  { case: 'a version 1 answer', value: { ...envelope, version: 1, family: 'answer' } },
  { case: 'a version 2 envelope of an unknown family', value: { ...envelope, family: 'other' } },
])('refuses $case', async ({ value }) => {
  const { path } = await repositoryWithFile(serializeRecord(value), 'm1.json');
  const result = await readEnvelope(path, { messageId: 'm1', terminal: 't7' });

  if (result.kind !== 'refused') {
    throw new Error(`Expected a refused envelope, got ${result.kind}`);
  }

  expect(result.reason).toMatch(/Malformed envelope/);
});

it.each([
  {
    case: 'a malformed fixture',
    fixture: 'malformed.json',
    fileName: 'malformed-message.json',
    messageId: 'malformed-message',
    reason: /Malformed envelope/,
  },
  {
    case: 'an unknown field fixture',
    fixture: 'unknown-field.json',
    fileName: 'unknown-message.json',
    messageId: 'unknown-message',
    reason: /Malformed envelope/,
  },
  {
    case: 'a newer fixture',
    fixture: 'newer.json',
    fileName: 'newer-message.json',
    messageId: 'newer-message',
    reason: /newer format/,
  },
])(
  'refuses $case with the ADR 0053 diagnostic',
  async ({ fixture, fileName, messageId, reason }) => {
    const { path } = await repositoryWithFixture(fixture, fileName);
    const result = await readEnvelope(path, { messageId, terminal: 't7' });

    if (result.kind !== 'refused') {
      throw new Error(`Expected a refused envelope, got ${result.kind}`);
    }

    expect(result.reason).toMatch(reason);
  },
);

it('refuses a path that reaches the inbox through a symlink and ..', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = await ensureTauDirectory(root, 'inbox');

  await writeFile(join(directory, 'm1.json'), serializeRecord(envelope));
  await mkdir(join(directory, 'nested'));
  await symlink(join(directory, 'nested'), join(directory, 'linked'), 'dir');

  const result = await readEnvelope(`${directory}/linked/../m1.json`, {
    messageId: 'm1',
    terminal: 't7',
  });

  expect(result.kind).toBe('refused');
});

it.each([
  {
    case: 'normal',
    fixture: 'current.json',
    fileName: 'current-message.json',
    messageId: 'current-message',
  },
  {
    case: 'version 1',
    fixture: 'v1.json',
    fileName: 'current-message.json',
    messageId: 'current-message',
  },
  { case: 'missing', fixture: undefined, fileName: 'missing.json', messageId: 'missing' },
  {
    case: 'malformed',
    fixture: 'malformed.json',
    fileName: 'malformed-message.json',
    messageId: 'malformed-message',
  },
])(
  'leaves the saved records unchanged for a $case read',
  async ({ fixture, fileName, messageId }) => {
    const root = await createTemporaryRepository(onTestFinished);
    const directory = await ensureTauDirectory(root, 'inbox');

    if (fixture !== undefined) {
      await copyFile(join(fixtures, fixture), join(directory, fileName));
    }

    const snapshot = async () =>
      Promise.all(
        (await readdir(directory))
          .toSorted()
          .map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
      );

    const before = await snapshot();

    await readEnvelope(join(directory, fileName), { messageId, terminal: 't7' });

    expect(await snapshot()).toEqual(before);
  },
);
