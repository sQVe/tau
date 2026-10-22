import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Type } from 'typebox';
import { expect, it, onTestFinished, vi } from 'vitest';

import {
  parseVersionedRecord,
  publishTextSync,
  readOptionalText,
  readTextWithinSync,
  readVersionedRecord,
  savedVersion,
  writeRecord,
} from './record.js';

const writeState = vi.hoisted(() => ({ failMidway: false, failFsync: false }));

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    fsyncSync: (descriptor: number) => {
      if (writeState.failFsync) {
        throw new Error('fsync failed');
      }

      actual.fsyncSync(descriptor);
    },
  };
});

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    writeFile: async (...parameters: Parameters<typeof actual.writeFile>) => {
      if (writeState.failMidway) {
        await actual.writeFile(parameters[0], 'cut-off');

        throw new Error('write failed');
      }

      return actual.writeFile(...parameters);
    },
  };
});

const options = {
  label: 'sample record',
  version: 2,
  schema: Type.Object({ version: Type.Literal(2), name: Type.String() }),
};

const directoryFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-record-'));

  onTestFinished(() => {
    writeState.failMidway = false;
    writeState.failFsync = false;

    return rm(directory, { recursive: true, force: true });
  });

  return directory;
};

it('returns undefined for a missing record', async () => {
  const directory = await directoryFixture();

  expect(await readVersionedRecord(join(directory, 'a.json'), options)).toBeUndefined();
});

it('returns a valid record', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.json');

  await writeFile(path, '{"version":2,"name":"x"}');

  expect(await readVersionedRecord(path, options)).toEqual({ version: 2, name: 'x' });
});

it('rejects text that is not JSON and keeps the parse error', () => {
  const failure = (): unknown => {
    try {
      parseVersionedRecord('a.json', '{', options);
    } catch (error) {
      return error;
    }

    return undefined;
  };

  expect(failure()).toMatchObject({
    message: expect.stringMatching(/^Malformed .*a\.json/) as unknown,
    cause: expect.any(SyntaxError) as unknown,
  });
});

it('rejects a newer version before it checks the schema', () => {
  expect(() => parseVersionedRecord('a.json', '{"version":3,"other":1}', options)).toThrow(
    /newer format/,
  );
});

it('rejects a known version that fails the schema', () => {
  expect(() => parseVersionedRecord('a.json', '{"version":2,"name":1}', options)).toThrow(
    /^Malformed .*\/name/,
  );
});

it('reports the problem from check before the schema', () => {
  expect(() =>
    parseVersionedRecord('a.json', '{"version":2}', { ...options, check: () => '/part bad' }),
  ).toThrow(/^Malformed .*\/part bad/);
});

it('picks the schema from the value', () => {
  const older = Type.Object({ version: Type.Literal(1) });

  const schema = (value: unknown) =>
    (value as { version: number }).version === 1 ? older : options.schema;

  expect(parseVersionedRecord('a.json', '{"version":1}', { ...options, schema })).toEqual({
    version: 1,
  });
});

it('reads optional text and gives undefined for a missing file', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.txt');

  await writeFile(path, 'hello');

  expect(await readOptionalText(path)).toBe('hello');
  expect(await readOptionalText(join(directory, 'missing.txt'))).toBeUndefined();
});

it('throws when the optional text path is a directory', async () => {
  const directory = await directoryFixture();

  await expect(readOptionalText(directory)).rejects.toThrow('EISDIR');
});

it('writes the record as indented JSON with a trailing newline', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.json');

  await writeRecord(path, { version: 2 });

  expect(await readFile(path, 'utf8')).toBe('{\n  "version": 2\n}\n');
  expect(await readdir(directory)).toEqual(['a.json']);
});

it('keeps the old record and leaves no temporary file when a write fails', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.json');

  await writeRecord(path, { version: 1 });

  const before = await readFile(path, 'utf8');

  writeState.failMidway = true;

  await expect(writeRecord(path, { version: 2 })).rejects.toThrow('write failed');
  expect(await readFile(path, 'utf8')).toBe(before);
  expect(await readdir(directory)).toEqual(['a.json']);
});

it('publishes text once and leaves no receipt file', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.json');

  publishTextSync(path, 'first', { mode: 0o600 });

  expect(() => {
    publishTextSync(path, 'second', { mode: 0o600 });
  }).toThrow('EEXIST');

  expect(await readFile(path, 'utf8')).toBe('first');
  expect(await readdir(directory)).toEqual(['a.json']);
});

it('reads text within the byte limit and refuses more', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.json');

  await writeFile(path, 'abcd');

  expect(readTextWithinSync(path, 4)).toBe('abcd');
  expect(readTextWithinSync(path, 3)).toBeUndefined();
  expect(() => readTextWithinSync(join(directory, 'missing.json'), 4)).toThrow('ENOENT');
});

it('reads the saved version of an object only', () => {
  expect(savedVersion({ version: 2 })).toBe(2);
  expect(savedVersion('text')).toBeUndefined();
  expect(savedVersion(null)).toBeUndefined();
});

it('leaves no receipt file when the file fsync fails', async () => {
  const directory = await directoryFixture();

  writeState.failFsync = true;

  expect(() => {
    publishTextSync(join(directory, 'a.json'), 'text', { mode: 0o600 });
  }).toThrow('fsync failed');

  expect(await readdir(directory)).toEqual([]);
});
