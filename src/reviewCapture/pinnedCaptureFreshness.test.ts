import { cp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import {
  captureWorkingTree,
  failGitCommand,
  failureOf,
  savedArtifactState,
  preparedReview,
  prepareDirectory,
  fixRepository,
  reviewRuntime,
} from './fixtures/reviewDirectoryHarness.js';
import { captureReviewDirectory } from './generation.js';
import { checkReviewFreshness } from './pinnedCapture.js';

it('reports fresh for an unchanged tree and saves the recapture as recheck.diff', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const captured = await captureWorkingTree(root, directory);
  const freshness = await checkReviewFreshness(root, directory);
  const recheckHash = await git(root, 'hash-object', join(directory, 'recheck.diff'));

  expect(freshness).toEqual({ status: 'fresh', reasons: [] });
  expect(recheckHash.trim()).toBe(captured['hash']);
});

it('reports stale after the working tree changes', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);
  await writeFile(join(root, 'tracked.txt'), 'three\n');

  const freshness = await checkReviewFreshness(root, directory);

  expect(freshness['status']).toBe('stale');
});

it('reports stale after a new commit with the same content', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);
  await git(root, 'commit', '--quiet', '--allow-empty', '-m', 'empty');

  const freshness = await checkReviewFreshness(root, directory);

  expect(freshness['status']).toBe('stale');
});

it('reports unknown when the recapture fails and leaves no recheck.diff', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');

  const captured = await captureWorkingTree(root, directory);
  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as object;
  const missingCommit = 'f'.repeat(40);

  await writeFile(
    join(directory, 'capture.json'),
    JSON.stringify({ ...record, target: { kind: 'workingTree', base: missingCommit } }),
  );

  await writeFile(join(directory, 'recheck.diff'), 'an earlier recheck\n');

  const freshness = await checkReviewFreshness(root, directory);

  expect(captured['empty']).toBe(false);
  expect(freshness['status']).toBe('unknown');
  expect(await readdir(directory)).not.toContain('recheck.diff');
});

it('refuses a saved target revision that Git could read as an option and writes nothing outside', async () => {
  const { root, directory } = await preparedReview();
  const outside = temporaryDirectory(onTestFinished, 'tau-review-outside-');

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);

  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as object;
  const base = `--output=${join(outside, 'written.diff')}`;

  await writeFile(
    join(directory, 'capture.json'),
    JSON.stringify({ ...record, target: { kind: 'workingTree', base } }),
  );

  expect(await failureOf(() => checkReviewFreshness(root, directory))).toContain('/target/base');
  expect(await readdir(outside)).toEqual([]);
});

it('refuses freshness without a saved record', async () => {
  const { root, directory } = await preparedReview();

  expect(await failureOf(() => checkReviewFreshness(root, directory))).toContain('capture.json');
});

it('reports unknown when HEAD cannot be read, removes the recheck, and keeps the saved capture', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);

  expect(await checkReviewFreshness(root, directory)).toEqual({ status: 'fresh', reasons: [] });

  const savedWithRecheck = await savedArtifactState(directory);
  const refs = await git(root, 'for-each-ref', 'refs/tau/review-captures/');

  await failGitCommand('--verify HEAD');

  expect(await checkReviewFreshness(root, directory)).toMatchObject({ status: 'unknown' });
  expect(await readdir(directory)).not.toContain('recheck.diff');

  expect(await savedArtifactState(directory)).toEqual(
    savedWithRecheck.filter(([name]) => name !== 'recheck.diff'),
  );

  expect(await git(root, 'for-each-ref', 'refs/tau/review-captures/')).toBe(refs);
});

it('reports unknown when the earlier review of a fix capture became a symlink', async () => {
  const root = await fixRepository();
  const review = await prepareDirectory(root);

  await writeFile(join(root, 'src', 'math.ts'), 'export const add = (a, b) => a + b + 0;\n');
  await captureWorkingTree(root, review);
  await writeFile(join(root, 'src', 'math.ts'), 'export const add = (a, b) => b + a;\n');

  const directory = await prepareDirectory(root);

  await captureReviewDirectory(
    root,
    directory,
    { kind: 'fix', review, findingPaths: [] },
    reviewRuntime(root),
  );

  const record = JSON.parse(await readFile(join(directory, 'capture.json'), 'utf8')) as {
    target: Record<string, unknown>;
  };

  const { predecessor: _predecessor, ...legacyTarget } = record.target;

  await writeFile(
    join(directory, 'capture.json'),
    JSON.stringify({ ...record, target: legacyTarget }),
  );

  const outside = join(temporaryDirectory(onTestFinished, 'tau-review-outside-'), 'review');

  await cp(review, outside, { recursive: true });
  await rm(review, { recursive: true });
  await symlink(outside, review);

  const freshness = await checkReviewFreshness(root, directory);

  expect(freshness).toMatchObject({ status: 'unknown' });
  expect(freshness.reasons.join('\n')).toContain('symlink');
});

it('reports unknown and removes the recheck when the hash command fails', async () => {
  const { root, directory } = await preparedReview();

  await writeFile(join(root, 'tracked.txt'), 'two\n');
  await captureWorkingTree(root, directory);
  await checkReviewFreshness(root, directory);
  await failGitCommand('--show-object-format');

  expect(await checkReviewFreshness(root, directory)).toMatchObject({ status: 'unknown' });
  expect(await readdir(directory)).not.toContain('recheck.diff');
});
