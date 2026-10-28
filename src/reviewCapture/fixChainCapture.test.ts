import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { createFreshTauDirectory } from '../tauDirectory.js';
import { captureGeneration } from './generation.js';
import {
  generationFolderName,
  generationPatchFileName,
  inputFileName,
  recordFileName,
} from './record.js';
import type { ReviewTarget } from './target.js';

interface SavedRecord {
  target: { predecessor?: { review: string } };
  endpoint: { status: string; tree?: string; ref?: string };
}

const reviewedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'a.ts'), 'a one\n');
  await writeFile(join(root, 'b.ts'), 'b one\n');
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'first');
  await writeFile(join(root, 'a.ts'), 'a two\n');

  return root;
};

const capturedReview = async (root: string, target: ReviewTarget) => {
  const directory = await createFreshTauDirectory(root, 'workers', 'review-');

  await writeFile(join(directory, inputFileName), '# Review input\n\n## Capture\n');
  await captureGeneration(root, directory, target);

  return directory;
};

const fixOf = (root: string, review: string) =>
  capturedReview(root, { kind: 'fix', review, findingPaths: ['a.ts'] });

const readPatch = (directory: string) =>
  readFile(join(directory, generationFolderName, generationPatchFileName), 'utf8');

const readRecord = async (directory: string) =>
  JSON.parse(await readFile(join(directory, recordFileName), 'utf8')) as SavedRecord;

it('captures only the change since the earlier fix capture', async () => {
  const root = await reviewedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });

  await writeFile(join(root, 'a.ts'), 'a three\n');

  const firstFix = await fixOf(root, review);

  await writeFile(join(root, 'b.ts'), 'b two\n');

  const secondFix = await fixOf(root, firstFix);
  const patch = await readPatch(secondFix);
  const { endpoint } = await readRecord(secondFix);

  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'fixed');

  expect(patch).toContain('diff --git a/b.ts b/b.ts');
  expect(patch).not.toContain('a.ts');

  expect(endpoint).toMatchObject({
    status: 'complete',
    tree: await git(root, 'rev-parse', 'HEAD^{tree}'),
  });
});

it('shows a reverted edit against the earlier fix and the whole change against the root', async () => {
  const root = await reviewedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });

  await writeFile(join(root, 'a.ts'), 'a three\n');

  const firstFix = await fixOf(root, review);

  await writeFile(join(root, 'a.ts'), 'a two\n');
  await writeFile(join(root, 'b.ts'), 'b two\n');

  const secondFix = await fixOf(root, firstFix);
  const rootFix = await fixOf(root, review);
  const rootPatch = await readPatch(rootFix);

  expect(await readPatch(secondFix)).toContain('-a three\n+a two\n');
  expect(rootPatch).toContain('-b one\n+b two\n');
  expect(rootPatch).not.toContain('a.ts');
  expect((await readRecord(secondFix)).target.predecessor?.review).toBe(firstFix);
  expect((await readRecord(rootFix)).target.predecessor?.review).toBe(review);
});

it('leaves the index unchanged while it writes the working tree for a chained fix', async () => {
  const root = await reviewedRepository();
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });

  await writeFile(join(root, 'a.ts'), 'a three\n');

  const firstFix = await fixOf(root, review);

  await writeFile(join(root, 'b.ts'), 'b two\n');

  const staged = await git(root, 'ls-files', '--stage');

  await fixOf(root, firstFix);

  expect(await git(root, 'ls-files', '--stage')).toBe(staged);
});

it('keeps the base commit of the chain in the endpoint ref of a chained fix', async () => {
  const root = await reviewedRepository();
  const base = await git(root, 'rev-parse', 'HEAD');
  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });

  await writeFile(join(root, 'a.ts'), 'a three\n');

  const firstFix = await fixOf(root, review);

  await writeFile(join(root, 'b.ts'), 'b two\n');

  const { endpoint } = await readRecord(await fixOf(root, firstFix));

  expect(await git(root, 'rev-parse', `${endpoint.ref ?? ''}^@`)).toBe(base);
});
