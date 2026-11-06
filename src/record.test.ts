import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Type } from 'typebox';
import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../tests/temporaryDirectoryHarness.js';
import {
  parseVersionedRecord,
  PublishError,
  publishTextSync,
  readContainedText,
  readOptionalText,
  readVersionedRecord,
  savedVersion,
  writeRecord,
} from './record.js';

const writeState = vi.hoisted(() => ({
  failMidway: false,
  fsyncCalls: 0,
  failFsyncCall: undefined as number | undefined,
  failUnlink: false,
}));

const raceState = vi.hoisted(() => ({ path: '', target: '' }));

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    fsyncSync: (descriptor: number) => {
      writeState.fsyncCalls += 1;

      if (writeState.fsyncCalls === writeState.failFsyncCall) {
        throw new Error('fsync failed');
      }

      actual.fsyncSync(descriptor);
    },
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (writeState.failUnlink) {
        throw new Error('unlink failed');
      }

      actual.unlinkSync(path);
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
    open: async (...parameters: Parameters<typeof actual.open>) => {
      const path = parameters[0];

      if (raceState.path !== '' && path === raceState.path) {
        await actual.unlink(path);
        await actual.symlink(raceState.target, path, 'file');
        raceState.path = '';
      }

      return actual.open(...parameters);
    },
  };
});

const options = {
  label: 'sample record',
  version: 2,
  schema: Type.Object({ version: Type.Literal(2), name: Type.String() }),
};

const directoryFixture = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-record-');

  onTestFinished(() => {
    writeState.failMidway = false;
    writeState.fsyncCalls = 0;
    writeState.failFsyncCall = undefined;
    writeState.failUnlink = false;
    raceState.path = '';
    raceState.target = '';
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

it('publishes text and leaves no receipt file', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.json');

  publishTextSync(path, 'first', { mode: 0o600 });

  expect(await readFile(path, 'utf8')).toBe('first');
  expect(await readdir(directory)).toEqual(['a.json']);
});

it.each([
  {
    case: 'the path already exists',
    existing: true,
    failFsyncCall: undefined,
    failure: 'exists',
    files: { 'a.json': 'first' },
  },
  {
    case: 'the file fsync fails',
    existing: false,
    failFsyncCall: 1,
    failure: 'notLinked',
    files: {},
  },
  {
    case: 'the folder fsync fails',
    existing: false,
    failFsyncCall: 2,
    failure: 'linked',
    files: { 'a.json': 'second' },
  },
])('reports $failure and leaves no receipt file when $case', async (row) => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.json');

  if (row.existing) {
    await writeFile(path, 'first');
  }

  writeState.failFsyncCall = row.failFsyncCall;

  const caught = (() => {
    try {
      publishTextSync(path, 'second', { mode: 0o600 });
    } catch (error) {
      return error;
    }

    return undefined;
  })();

  const names = await readdir(directory);

  const entries = await Promise.all(
    names.map(async (name): Promise<[string, string]> => [
      name,
      await readFile(join(directory, name), 'utf8'),
    ]),
  );

  const files = Object.fromEntries(entries);

  expect(caught).toBeInstanceOf(PublishError);
  expect((caught as PublishError).failure).toBe(row.failure);
  expect(files).toEqual(row.files);
});

it('reports exists with the link error when removing the receipt file also fails', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'a.json');

  await writeFile(path, 'first');

  writeState.failUnlink = true;

  const caught = (() => {
    try {
      publishTextSync(path, 'second', { mode: 0o600 });
    } catch (error) {
      return error;
    }

    return undefined;
  })();

  expect(caught).toBeInstanceOf(PublishError);
  expect((caught as PublishError).failure).toBe('exists');
  expect((caught as PublishError).cause).toMatchObject({ code: 'EEXIST' });
  expect((caught as PublishError).message).toContain('unlink failed');
  expect(await readFile(path, 'utf8')).toBe('first');
});

it('reads the saved version of an object only', () => {
  expect(savedVersion({ version: 2 })).toBe(2);
  expect(savedVersion('text')).toBeUndefined();
  expect(savedVersion(null)).toBeUndefined();
});

const containedRequest = (directory: string, path: string, byteLimit = 100) => ({
  directory,
  path,
  byteLimit,
  label: 'message' as const,
});

it('reads contained text within the byte limit', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'message.txt');

  await writeFile(path, 'hello');

  expect(await readContainedText(containedRequest(directory, path, 5))).toBe('hello');
});

it('refuses a symlink inside the allowed directory', async () => {
  const directory = await directoryFixture();
  const target = join(directory, 'target.txt');
  const link = join(directory, 'link.txt');

  await writeFile(target, 'hello');
  await symlink(target, link, 'file');

  await expect(readContainedText(containedRequest(directory, link))).rejects.toThrow(/symlink/);
});

it('refuses a symlinked parent directory', async () => {
  const directory = await directoryFixture();
  const real = join(directory, 'real');
  const link = join(directory, 'link');

  await mkdir(real);
  await writeFile(join(real, 'message.txt'), 'hello');
  await symlink(real, link, 'dir');

  await expect(
    readContainedText(containedRequest(directory, join(link, 'message.txt'))),
  ).rejects.toThrow(/symlink/);
});

it('refuses a directory', async () => {
  const directory = await directoryFixture();
  const subdirectory = join(directory, 'sub');

  await mkdir(subdirectory);

  await expect(readContainedText(containedRequest(directory, subdirectory))).rejects.toThrow(
    /not a regular file/,
  );
});

it('refuses an empty file', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'message.txt');

  await writeFile(path, '');

  await expect(readContainedText(containedRequest(directory, path))).rejects.toThrow(/is empty/);
});

it('refuses a file over the byte limit', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'message.txt');

  await writeFile(path, 'hello');

  await expect(readContainedText(containedRequest(directory, path, 4))).rejects.toThrow(
    /larger than 4 bytes/,
  );
});

it('refuses a missing file', async () => {
  const directory = await directoryFixture();

  await expect(
    readContainedText(containedRequest(directory, join(directory, 'missing.txt'))),
  ).rejects.toThrow(/does not exist/);
});

it('refuses a path with a parent component', async () => {
  const directory = await directoryFixture();
  const path = `${directory}/nested/../message.txt`;

  await writeFile(join(directory, 'message.txt'), 'hello');

  await expect(readContainedText(containedRequest(directory, path))).rejects.toThrow(
    /not canonical/,
  );
});

it('refuses an approved directory reached through a symlink', async () => {
  const directory = await directoryFixture();
  const real = join(directory, 'real');
  const alias = join(directory, 'alias');

  await mkdir(real);
  await writeFile(join(real, 'message.txt'), 'hello');
  await symlink(real, alias, 'dir');

  await expect(
    readContainedText(containedRequest(alias, join(alias, 'message.txt'))),
  ).rejects.toThrow(/symlinked approved directory/);
});

it('refuses a symlink that appears at open time', async () => {
  const directory = await directoryFixture();
  const outsideDirectory = await directoryFixture();
  const link = join(directory, 'link.txt');
  const outside = join(outsideDirectory, 'outside.txt');

  await writeFile(link, 'hello');
  await writeFile(outside, 'outside bytes');

  raceState.path = link;
  raceState.target = outside;

  await expect(readContainedText(containedRequest(directory, link))).rejects.toThrow(/symlink/);
});

it('refuses a FIFO without waiting for a writer', async () => {
  const directory = await directoryFixture();
  const path = join(directory, 'message.fifo');

  execFileSync('mkfifo', [path]);

  await expect(readContainedText(containedRequest(directory, path))).rejects.toThrow(
    /not a regular file/,
  );
});

it('refuses a missing approved directory', async () => {
  const directory = await directoryFixture();
  const missing = join(directory, 'missing');

  await expect(
    readContainedText(containedRequest(missing, join(missing, 'message.txt'))),
  ).rejects.toThrow(/directory does not exist/);
});

it.each([
  { case: 'normal', content: 'hello' as string | undefined },
  { case: 'missing', content: undefined },
  { case: 'malformed', content: 'x'.repeat(200) },
])('leaves the approved directory unchanged for a $case read', async ({ content }) => {
  const directory = await directoryFixture();
  const path = join(directory, 'message.txt');

  if (content !== undefined) {
    await writeFile(path, content);
  }

  const snapshot = async () =>
    Promise.all(
      (await readdir(directory))
        .toSorted()
        .map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
    );

  const before = await snapshot();

  await readContainedText(containedRequest(directory, path)).catch(() => undefined);

  expect(await snapshot()).toEqual(before);
});
