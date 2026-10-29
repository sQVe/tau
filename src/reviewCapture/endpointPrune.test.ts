import { chmod, mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { readCompletedCapture } from './completedCapture.js';
import { pruneEndpointRefs } from './endpointPrune.js';
import { captureGeneration } from './generation.js';
import { generationFolderName, recordFileName } from './record.js';

const day = 24 * 60 * 60 * 1000;
const isRoot = process.getuid?.() === 0;

const commitFile = async (root: string, text: string) => {
  await writeFile(join(root, 'tracked.txt'), text);
  await git(root, 'add', 'tracked.txt');
  await git(root, 'commit', '--quiet', '-m', text);

  return git(root, 'rev-parse', 'HEAD');
};

const reviewDirectory = async (root: string, name: string) => {
  const directory = join(root, '.tau', 'workers', name);

  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'input.md'), '# Review input\n\n## Capture\n');

  return directory;
};

const capturedReview = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, '.gitignore'), '.tau/\n');

  const from = await commitFile(root, 'one\n');
  const to = await commitFile(root, 'two\n');
  const directory = await reviewDirectory(root, 'review-one');
  const { identity } = await captureGeneration(root, directory, { kind: 'range', from, to });
  const ref = `refs/tau/review-captures/${basename(directory)}`;
  const commit = await git(root, 'rev-parse', ref);

  return { root, directory, identity, ref, commit };
};

const refExists = async (root: string, ref: string) =>
  git(root, 'show-ref', '--verify', '--quiet', ref).then(
    () => true,
    () => false,
  );

const objectExists = async (root: string, object: string) =>
  git(root, 'cat-file', '-e', object).then(
    () => true,
    () => false,
  );

it('removes the ref of a deleted review directory so gc drops its commit', async () => {
  const { root, directory, ref, commit } = await capturedReview();

  await rm(directory, { recursive: true });
  await pruneEndpointRefs(root, Date.now());
  await git(root, 'gc', '--quiet', '--prune=now');

  expect(await refExists(root, ref)).toBe(false);
  expect(await objectExists(root, commit)).toBe(false);
});

it('keeps the ref of a completed capture, which still reads as completed', async () => {
  const { root, directory, identity, ref, commit } = await capturedReview();

  await pruneEndpointRefs(root, Date.now() + 365 * day);

  expect(await git(root, 'rev-parse', ref)).toBe(commit);

  expect(await readCompletedCapture(root, directory, identity)).toMatchObject({
    status: 'completed',
  });
});

it('removes the ref of an interrupted capture only a day after its last write', async () => {
  const { root, directory, ref, commit } = await capturedReview();
  const lastWrite = new Date(Date.now() + 365 * day);
  const earlierWrite = new Date(lastWrite.getTime() - 10 * day);

  await rm(join(directory, recordFileName));
  await utimes(directory, earlierWrite, earlierWrite);
  await utimes(join(directory, generationFolderName), lastWrite, lastWrite);
  await pruneEndpointRefs(root, lastWrite.getTime() + day - 1);

  expect(await git(root, 'rev-parse', ref)).toBe(commit);

  await pruneEndpointRefs(root, lastWrite.getTime() + day);

  expect(await refExists(root, ref)).toBe(false);
});

it('keeps the ref of a deleted review that a fix capture compares against', async () => {
  const { root, directory, ref, commit } = await capturedReview();
  const fixDirectory = await reviewDirectory(root, 'review-fix');

  await writeFile(join(root, 'tracked.txt'), 'three\n');

  const { identity } = await captureGeneration(root, fixDirectory, {
    kind: 'fix',
    review: directory,
    findingPaths: ['tracked.txt'],
  });

  await rm(directory, { recursive: true });
  await pruneEndpointRefs(root, Date.now());
  await git(root, 'gc', '--quiet', '--prune=now');

  expect(await git(root, 'rev-parse', ref)).toBe(commit);

  expect(await readCompletedCapture(root, fixDirectory, identity)).toMatchObject({
    status: 'completed',
  });
});

it.skipIf(isRoot)('keeps every ref while another capture record cannot be read', async () => {
  const { root, directory, ref, commit } = await capturedReview();
  const unreadable = await reviewDirectory(root, 'review-two');

  await writeFile(join(unreadable, recordFileName), '{}\n');
  await chmod(join(unreadable, recordFileName), 0o000);
  onTestFinished(() => chmod(join(unreadable, recordFileName), 0o644));
  await rm(directory, { recursive: true });
  await pruneEndpointRefs(root, Date.now());

  expect(await git(root, 'rev-parse', ref)).toBe(commit);
});

it('removes a ref once when two prunes run at the same time', async () => {
  const { root, directory, ref } = await capturedReview();

  await rm(directory, { recursive: true });
  await Promise.all([pruneEndpointRefs(root, Date.now()), pruneEndpointRefs(root, Date.now())]);

  expect(await refExists(root, ref)).toBe(false);
});

it('keeps a ref whose review path cannot be read as a directory', async () => {
  const { root, directory, ref, commit } = await capturedReview();

  await rm(directory, { recursive: true });
  await writeFile(directory, 'not a directory\n');
  await pruneEndpointRefs(root, Date.now() + 365 * day);

  expect(await git(root, 'rev-parse', ref)).toBe(commit);
});

it('keeps a ref whose review directory is in another worktree', async () => {
  const { root, directory, ref, commit } = await capturedReview();
  const other = join(root, '.tau', 'other');

  await git(root, 'worktree', 'add', '--quiet', '--detach', other);
  await mkdir(join(other, '.tau', 'workers'), { recursive: true });
  await rename(directory, join(other, '.tau', 'workers', basename(directory)));
  await pruneEndpointRefs(root, Date.now());

  expect(await git(root, 'rev-parse', ref)).toBe(commit);
});

it('keeps every ref while a locked worktree is unavailable', async () => {
  const { root, directory, ref, commit } = await capturedReview();
  const other = join(root, '.tau', 'other');

  await git(root, 'worktree', 'add', '--quiet', '--detach', other);
  await git(root, 'worktree', 'lock', other);
  await rename(other, `${other}-unmounted`);
  await rm(directory, { recursive: true });
  await pruneEndpointRefs(root, Date.now());

  expect(await git(root, 'rev-parse', ref)).toBe(commit);
});

it('prunes while a locked worktree is available', async () => {
  const { root, directory, ref } = await capturedReview();
  const other = join(root, '.tau', 'other');

  await git(root, 'worktree', 'add', '--quiet', '--detach', other);
  await git(root, 'worktree', 'lock', other);
  await rm(directory, { recursive: true });
  await pruneEndpointRefs(root, Date.now());

  expect(await refExists(root, ref)).toBe(false);
});

it('prunes while an unlocked worktree folder is gone', async () => {
  const { root, directory, ref } = await capturedReview();
  const other = join(root, '.tau', 'other');

  await git(root, 'worktree', 'add', '--quiet', '--detach', other);
  await rm(other, { recursive: true });
  await rm(directory, { recursive: true });
  await pruneEndpointRefs(root, Date.now());

  expect(await refExists(root, ref)).toBe(false);
});

it('keeps a ref under the prefix that names no review directory', async () => {
  const { root, commit } = await capturedReview();
  const nested = 'refs/tau/review-captures/review-one/nested';
  const other = 'refs/tau/review-captures/other';

  await git(root, 'update-ref', '-d', 'refs/tau/review-captures/review-one');
  await git(root, 'update-ref', nested, commit);
  await git(root, 'update-ref', other, commit);
  await pruneEndpointRefs(root, Date.now() + day);

  expect(await refExists(root, nested)).toBe(true);
  expect(await refExists(root, other)).toBe(true);
});
