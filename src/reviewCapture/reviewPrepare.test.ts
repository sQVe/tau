import { mkdir, rm, symlink, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { temporaryDirectory } from '../../tests/temporaryDirectoryHarness.js';
import { captureReviewDirectory } from './generation.js';
import { prepareReviewDirectory } from './reviewPrepare.js';

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'tracked.txt'), 'one\n');
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', 'first');

  return root;
};

// Saves a capture of a working-tree edit in a new review directory and returns that directory.
const capturedReview = async (root: string, text: string) => {
  const directory = await prepareReviewDirectory(root, Date.now());

  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');
  await writeFile(join(root, 'tracked.txt'), text);
  await captureReviewDirectory(root, directory, { kind: 'workingTree', base: 'HEAD' });

  return directory;
};

const captureRefs = (root: string) =>
  git(root, 'for-each-ref', '--format=%(refname)', 'refs/tau/review-captures/');

it('creates a distinct review directory on each call, and Git ignores both', async () => {
  const root = await committedRepository();
  const first = await prepareReviewDirectory(root, Date.now());
  const second = await prepareReviewDirectory(root, Date.now());

  expect(first).toMatch(/\/\.tau\/workers\/review-[^/]+$/);
  expect(second).not.toBe(first);
  expect(await git(root, 'status', '--porcelain')).toBe('');
});

it('removes the capture ref of a deleted review and keeps the ref of a live review', async () => {
  const root = await committedRepository();
  const deleted = await capturedReview(root, 'two\n');
  const live = await capturedReview(root, 'three\n');
  const liveRef = `refs/tau/review-captures/${live.split('/').at(-1) ?? ''}`;

  await rm(deleted, { recursive: true });
  await prepareReviewDirectory(root, Date.now());

  const refs = await captureRefs(root);

  expect(refs.split('\n')).toEqual([liveRef]);
});

it('refuses to prepare through a symlinked .tau/workers and keeps capture refs', async () => {
  const root = await committedRepository();
  const outside = temporaryDirectory(onTestFinished, 'tau-review-outside-');
  const ref = 'refs/tau/review-captures/review-gone';

  await git(root, 'update-ref', ref, 'HEAD');
  await mkdir(join(root, '.tau'));
  await symlink(outside, join(root, '.tau', 'workers'));

  await expect(prepareReviewDirectory(root, Date.now())).rejects.toThrow('symlink');
  expect(await readdir(outside)).toEqual([]);
  expect(await git(root, 'for-each-ref', '--format=%(refname)', ref)).toBe(ref);
});
