import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { readCompletedCapture } from './generation.js';
import {
  generationFolderName,
  generationInputFileName,
  generationPatchFileName,
  inputFileName,
  recordFileName,
} from './record.js';

const sha = 'a'.repeat(40);

const blobHash = (root: string, bytes: Buffer) =>
  execFileSync('git', ['hash-object', '--stdin'], { cwd: root, input: bytes })
    .toString('utf8')
    .trim();

// Saves a version 3 generation the way a capture folder holds it, and returns its record bytes.
const saveGeneration = async (root: string, directory: string) => {
  const patch = Buffer.from('diff --git a/src/a.ts b/src/a.ts\n');
  const input = Buffer.from('# Review input\n');
  const folder = join(directory, generationFolderName);

  await mkdir(folder);
  await writeFile(join(folder, generationPatchFileName), patch);
  await writeFile(join(folder, generationInputFileName), input);

  const record = {
    version: 3,
    target: { kind: 'workingTree', base: sha },
    base: sha,
    head: sha,
    hash: sha,
    gaps: [],
    original: { patch: blobHash(root, patch), input: blobHash(root, input) },
  };

  await writeFile(join(directory, recordFileName), JSON.stringify(record));
  await writeFile(join(directory, inputFileName), '# Review input\n\n## Capture\n');
};

const recordPath = (directory: string) => join(directory, recordFileName);

const recordIdentity = async (root: string, directory: string) =>
  blobHash(root, await readFile(recordPath(directory)));

const savedFilePaths = (directory: string) => [
  recordPath(directory),
  join(directory, generationFolderName, generationPatchFileName),
  join(directory, generationFolderName, generationInputFileName),
  join(directory, inputFileName),
];

// The bytes of each saved file. A missing file reads as undefined, so a read that creates it shows.
const readSavedFiles = (directory: string) =>
  Promise.all(savedFilePaths(directory).map((path) => readFile(path).catch(() => undefined)));

it('returns completed with the identity of the saved record', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await saveGeneration(root, directory);
  const before = await readSavedFiles(directory);

  expect(await readCompletedCapture(root, directory)).toEqual({
    status: 'completed',
    identity: await recordIdentity(root, directory),
    reasons: [],
  });

  expect(await readSavedFiles(directory)).toEqual(before);
});

it('returns altered when one byte of capture/patch.diff changes', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await saveGeneration(root, directory);

  const patchPath = join(directory, generationFolderName, generationPatchFileName);
  const saved = await readFile(patchPath, 'utf8');

  await writeFile(patchPath, saved.replace('diff', 'Diff'));

  const decision = await readCompletedCapture(root, directory);

  expect(decision.status).toBe('altered');
});

it('returns incomplete when the capture folder has no record', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await mkdir(join(directory, generationFolderName));

  expect((await readCompletedCapture(root, directory)).status).toBe('incomplete');
});

it('refuses a directory with neither a record nor a capture folder', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await expect(readCompletedCapture(root, directory)).rejects.toThrow(recordPath(directory));
});

it('refuses a capture record that is a link', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');
  const elsewhere = temporaryDirectory(onTestFinished, 'tau-review-elsewhere-');

  await saveGeneration(root, elsewhere);
  await symlink(recordPath(elsewhere), recordPath(directory));

  await expect(readCompletedCapture(root, directory)).rejects.toThrow('symlink');
});

it('returns completed for a matching expected identity and changes no saved file', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await saveGeneration(root, directory);
  const identity = await recordIdentity(root, directory);
  const before = await readSavedFiles(directory);

  expect(await readCompletedCapture(root, directory, identity)).toEqual({
    status: 'completed',
    identity,
    reasons: [],
  });

  expect(await readSavedFiles(directory)).toEqual(before);
});

it('returns altered for a mismatching expected identity and changes no saved file', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await saveGeneration(root, directory);
  const before = await readSavedFiles(directory);

  const decision = await readCompletedCapture(root, directory, 'b'.repeat(40));

  expect(decision.status).toBe('altered');
  expect(await readSavedFiles(directory)).toEqual(before);
});

it('returns legacy for a version 2 record and changes no saved file', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  const record = {
    version: 2,
    target: { kind: 'workingTree', base: sha },
    base: sha,
    head: sha,
    hash: sha,
  };

  await writeFile(recordPath(directory), JSON.stringify(record));
  const before = await readSavedFiles(directory);

  expect((await readCompletedCapture(root, directory)).status).toBe('legacy');
  expect(await readSavedFiles(directory)).toEqual(before);
});

it('returns missing when a saved artifact is gone and changes no saved file', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await saveGeneration(root, directory);
  await rm(join(directory, generationFolderName, generationPatchFileName));
  const before = await readSavedFiles(directory);

  expect((await readCompletedCapture(root, directory)).status).toBe('missing');
  expect(await readSavedFiles(directory)).toEqual(before);
});

it('refuses a malformed capture record and changes no saved file', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await saveGeneration(root, directory);
  await writeFile(recordPath(directory), '{ "version": 3');
  const before = await readSavedFiles(directory);

  await expect(readCompletedCapture(root, directory)).rejects.toThrow(recordPath(directory));
  expect(await readSavedFiles(directory)).toEqual(before);
});
