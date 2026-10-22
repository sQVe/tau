import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../../tests/gitRepository.js';
import { saveCollectedRecord } from './collectedRecord.js';
import { savePlacement, stageReview } from './stage.js';

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

const collected = { comments: [], edits: [] };

const directoryFixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tau-record-write-'));

  onTestFinished(() => {
    writeState.failMidway = false;
    writeState.failBefore = false;

    return rm(directory, { recursive: true, force: true });
  });

  return directory;
};

const stagedReview = async () => {
  const repository = await createTemporaryRepository(onTestFinished, 'tau-record-write-repo-');
  const data = await directoryFixture();
  vi.stubEnv('TMPDIR', data);

  onTestFinished(() => {
    vi.unstubAllEnvs();
  });

  await mkdir(join(repository, '.tau/slices'), { recursive: true });
  await writeFile(join(repository, '.tau/slices/a.md'), 'one\n');

  return stageReview(repository, ['.tau/slices/a.md']);
};

it('leaves no collected record and no temporary file when the first save fails midway', async () => {
  const directory = await directoryFixture();

  writeState.failMidway = true;

  await expect(saveCollectedRecord(directory, collected)).rejects.toThrow('write failed');
  expect(await readdir(directory)).toEqual([]);
});

it('keeps the earlier collected record when a save fails midway', async () => {
  const directory = await directoryFixture();

  await saveCollectedRecord(directory, collected);

  const before = await readFile(join(directory, 'collected.json'), 'utf8');

  writeState.failMidway = true;

  await expect(saveCollectedRecord(directory, collected)).rejects.toThrow('write failed');
  expect(await readFile(join(directory, 'collected.json'), 'utf8')).toBe(before);
  expect(await readdir(directory)).toEqual(['collected.json']);
});

it('refuses to write the collected record through a symlink', async () => {
  const directory = await directoryFixture();
  const outside = join(directory, 'outside.txt');

  await writeFile(outside, 'outside');
  await symlink(outside, join(directory, 'collected.json'));

  await expect(saveCollectedRecord(directory, collected)).rejects.toThrow('symlink');
  expect(await readFile(outside, 'utf8')).toBe('outside');
});

it('keeps the earlier manifest when a placement save fails midway', async () => {
  const review = await stagedReview();
  const before = await readdir(review.recordDirectory);
  const manifest = join(review.recordDirectory, 'review.json');
  const text = await readFile(manifest, 'utf8');

  writeState.failMidway = true;

  await expect(savePlacement(review, { kind: 'split', terminalId: 't9' })).rejects.toThrow(
    'write failed',
  );

  expect(await readFile(manifest, 'utf8')).toBe(text);
  expect(await readdir(review.recordDirectory)).toEqual(before);
  expect(review.placement).toBeNull();
});

it('reports the write error when the temporary file was never created', async () => {
  const directory = await directoryFixture();

  writeState.failBefore = true;

  await expect(saveCollectedRecord(directory, collected)).rejects.toThrow('write refused');
  expect(await readdir(directory)).toEqual([]);
});
