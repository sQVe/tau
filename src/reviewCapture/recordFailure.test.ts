import { readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { recordFileName, writeCaptureRecord } from './record.js';

const writeState = vi.hoisted(() => ({ failMidway: false, failBefore: false }));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    writeFile: async (...parameters: Parameters<typeof actual.writeFile>) => {
      if (writeState.failBefore) {
        throw new Error('write refused');
      }

      if (writeState.failMidway) {
        await actual.writeFile(parameters[0], 'cut-off');

        throw new Error('write failed');
      }

      return actual.writeFile(...parameters);
    },
  };
});

const record = {
  version: 2,
  target: { kind: 'rootCommit', commit: 'a'.repeat(40) },
  base: null,
  head: 'b'.repeat(40),
  hash: 'c'.repeat(40),
} as const;

const reviewDirectory = async () => {
  const directory = temporaryDirectory(onTestFinished, 'tau-record-failure-');

  onTestFinished(() => {
    writeState.failMidway = false;
    writeState.failBefore = false;
  });

  return directory;
};

it('leaves no record and no temporary file when the first write fails midway', async () => {
  const directory = await reviewDirectory();

  writeState.failMidway = true;

  await expect(writeCaptureRecord(directory, record)).rejects.toThrow('write failed');
  expect(await readdir(directory)).toEqual([]);
});

it('keeps the earlier record when a rewrite fails midway', async () => {
  const directory = await reviewDirectory();

  await writeCaptureRecord(directory, record);

  const before = await readFile(join(directory, recordFileName), 'utf8');

  writeState.failMidway = true;

  await expect(writeCaptureRecord(directory, { ...record, hash: 'd'.repeat(40) })).rejects.toThrow(
    'write failed',
  );

  expect(await readFile(join(directory, recordFileName), 'utf8')).toBe(before);
  expect(await readdir(directory)).toEqual([recordFileName]);
});

it('refuses to write through a symlink at the record', async () => {
  const directory = await reviewDirectory();
  const outside = join(directory, 'outside.txt');

  await writeFile(outside, 'outside');
  await symlink(outside, join(directory, recordFileName));

  await expect(writeCaptureRecord(directory, record)).rejects.toThrow('symlink');
  expect(await readFile(outside, 'utf8')).toBe('outside');
});

it('reports the write error when the temporary file was never created', async () => {
  const directory = await reviewDirectory();

  writeState.failBefore = true;

  await expect(writeCaptureRecord(directory, record)).rejects.toThrow('write refused');
  expect(await readdir(directory)).toEqual([]);
});
