import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished, vi } from 'vitest';

import { createTemporaryRepository } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { snapshotFolder } from './fixCapture.js';
import { captureGeneration, readCompletedCapture } from './generation.js';
import {
  generationFolderName,
  generationInputFileName,
  generationPatchFileName,
  inputFileName,
  recordFileName,
} from './record.js';

const statFailure = vi.hoisted(() => ({ suffix: '' }));

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal();

  return {
    ...actual,
    stat: (async (...parameters: Parameters<typeof actual.stat>) => {
      if (statFailure.suffix !== '' && String(parameters[0]).endsWith(statFailure.suffix)) {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      }

      return actual.stat(...parameters);
    }) as typeof actual.stat,
  };
});

const sha = 'a'.repeat(40);

const blobHash = (root: string, bytes: Buffer) =>
  execFileSync('git', ['hash-object', '--stdin'], { cwd: root, input: bytes })
    .toString('utf8')
    .trim();

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

const capturedWorkingTree = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await writeFile(join(root, 'a.txt'), 'one\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'two\n');
  await writeFile(join(directory, inputFileName), '# Review input\n\n## Capture\n');
  await captureGeneration(root, directory, { kind: 'workingTree', base: 'HEAD' });

  return { root, directory, copy: join(directory, snapshotFolder, 'a.txt') };
};

it('returns completed for an untouched working tree capture with a snapshot', async () => {
  const { root, directory } = await capturedWorkingTree();

  expect((await readCompletedCapture(root, directory)).status).toBe('completed');
});

it('returns altered when one byte of a saved snapshot copy changes', async () => {
  const { root, directory, copy } = await capturedWorkingTree();

  await writeFile(copy, 'twO\n');

  expect((await readCompletedCapture(root, directory)).status).toBe('altered');
});

it('returns missing when a saved snapshot copy is deleted', async () => {
  const { root, directory, copy } = await capturedWorkingTree();

  await rm(copy);

  expect((await readCompletedCapture(root, directory)).status).toBe('missing');
});

it('returns missing when a saved snapshot copy goes away between its read and its mode', async () => {
  const { root, directory } = await capturedWorkingTree();

  statFailure.suffix = join(snapshotFolder, 'a.txt');

  onTestFinished(() => {
    statFailure.suffix = '';
  });

  expect((await readCompletedCapture(root, directory)).status).toBe('missing');
});

it('refuses a capture record that names a snapshot path outside the repository', async () => {
  const { root, directory } = await capturedWorkingTree();
  const recordFile = recordPath(directory);

  const record = JSON.parse(await readFile(recordFile, 'utf8')) as {
    snapshot: { present: string[] };
  };

  record.snapshot.present = ['../outside.txt'];
  await writeFile(recordFile, JSON.stringify(record));

  await expect(readCompletedCapture(root, directory)).rejects.toThrow('../outside.txt');
});

it('returns altered when only the mode of a saved snapshot copy changes', async () => {
  const { root, directory, copy } = await capturedWorkingTree();

  await chmod(copy, 0o644);
  const completed = await readCompletedCapture(root, directory);

  await chmod(copy, 0o755);

  expect(completed.status).toBe('completed');
  expect((await readCompletedCapture(root, directory)).status).toBe('altered');
});

it('records no snapshot hash for a range capture', async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const directory = temporaryDirectory(onTestFinished, 'tau-review-generation-');

  await writeFile(join(root, 'a.txt'), 'one\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: root });
  execFileSync('git', ['commit', '--quiet', '-m', 'first'], { cwd: root });
  await writeFile(join(root, 'a.txt'), 'two\n');
  execFileSync('git', ['commit', '--quiet', '-am', 'second'], { cwd: root });
  await writeFile(join(directory, inputFileName), '# Review input\n\n## Capture\n');
  await captureGeneration(root, directory, { kind: 'range', from: 'HEAD~1', to: 'HEAD' });

  const record = JSON.parse(await readFile(recordPath(directory), 'utf8')) as {
    original: Record<string, string>;
  };

  expect(Object.keys(record.original)).toEqual(['patch', 'input']);
  expect((await readCompletedCapture(root, directory)).status).toBe('completed');
});
