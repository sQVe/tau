import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { readCompletedCapture } from './completedCapture.js';
import { readReviewEvidence } from './evidence.js';
import { captureReviewDirectory } from './generation.js';
import { checkReviewFreshness } from './pinnedCapture.js';
import { prepareReviewDirectory } from './reviewPrepare.js';

const savedFiles = ['capture/patch.diff', 'capture/input.md', 'capture.json'];

const readSavedFiles = (directory: string) =>
  Promise.all(savedFiles.map((name) => readFile(join(directory, name))));

// Every saved snapshot file with its text and permission bits, so a changed mode shows.
const readSnapshot = async (directory: string) => {
  const snapshotDirectory = join(directory, 'snapshot');

  const entries = await readdir(snapshotDirectory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );

  const files = entries.filter((entry) => entry.isFile());

  return Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);

      return [
        path.slice(snapshotDirectory.length + 1),
        await readFile(path, 'utf8'),
        (await stat(path)).mode & 0o777,
      ];
    }),
  );
};

// The saved bytes, the snapshot, and the endpoint refs that a capture leaves behind.
const readSavedState = async (root: string, directory: string) => ({
  files: await readSavedFiles(directory),
  snapshot: await readSnapshot(directory),
  refs: await git(
    root,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/tau/review-captures/',
  ),
});

const readRecord = async (directory: string) =>
  JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as Record<string, unknown>;

const freshness = (root: string, directory: string) => checkReviewFreshness(root, directory);

const repositoryWithReview = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  const firstCommit = await git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await git(root, 'commit', '--quiet', '-am', 'second');

  const directory = await prepareReviewDirectory(root, Date.now());

  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');

  return { root, directory, firstCommit };
};

it('keeps the saved capture bytes through repeated freshness and evidence after edits', async () => {
  const { root, directory } = await repositoryWithReview();
  const originalHead = await git(root, 'rev-parse', 'HEAD');

  await writeFile(join(root, 'tracked.txt'), 'three\n');

  const captured = await captureReviewDirectory(root, directory, {
    kind: 'workingTree',
    base: 'HEAD~1',
  });

  const saved = await readSavedState(root, directory);
  const originalRecord = await readRecord(directory);

  expect(saved.snapshot.length).toBeGreaterThan(0);
  expect(await freshness(root, directory)).toMatchObject({ status: 'fresh' });
  expect(await readSavedState(root, directory)).toEqual(saved);

  await writeFile(join(root, 'tracked.txt'), 'four\n');

  expect(await freshness(root, directory)).toMatchObject({ status: 'stale' });
  expect(await readSavedState(root, directory)).toEqual(saved);
  expect(await readdir(directory)).toContain('recheck.diff');

  await writeFile(join(root, 'tracked.txt'), 'five\n');

  expect(await readReviewEvidence(root, directory)).toMatchObject({
    freshness: { status: 'stale' },
  });

  expect(await readSavedState(root, directory)).toEqual(saved);

  const record = await readRecord(directory);

  expect(record['head']).toBe(originalHead);
  expect(record['hash']).toBe(originalRecord['hash']);
  expect(record['hash']).toBe(captured['hash']);

  expect(await readCompletedCapture(root, directory)).toEqual({
    status: 'completed',
    identity: captured['identity'],
    reasons: [],
    endpoint: 'complete',
  });
});

it('reports unknown when a pinned revision cannot be read and keeps the saved capture', async () => {
  const { root, directory, firstCommit } = await repositoryWithReview();

  await writeFile(join(root, 'tracked.txt'), 'three\n');

  await captureReviewDirectory(root, directory, { kind: 'workingTree', base: firstCommit });

  const saved = await readSavedState(root, directory);

  await rm(join(root, '.git', 'objects', firstCommit.slice(0, 2), firstCommit.slice(2)));

  expect(await freshness(root, directory)).toMatchObject({ status: 'unknown' });
  expect(await readdir(directory)).not.toContain('recheck.diff');
  expect(await readSavedState(root, directory)).toEqual(saved);
});
