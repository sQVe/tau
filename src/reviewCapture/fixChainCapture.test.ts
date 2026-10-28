import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  gaps: { kind: string; path: string }[];
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

it('keeps a force-tracked ignored file in the working tree of a chained fix', async () => {
  const root = await reviewedRepository();

  await writeFile(join(root, '.gitignore'), 'ignored.ts\n');
  await git(root, 'add', '.gitignore');
  await git(root, 'commit', '--quiet', '-m', 'ignore');
  await writeFile(join(root, 'ignored.ts'), 'reviewed\n');
  await git(root, 'add', '-f', 'ignored.ts');

  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });

  await writeFile(join(root, 'ignored.ts'), 'fixed\n');

  const index = await readFile(join(root, '.git', 'index'));
  const fix = await fixOf(root, review);
  const indexAfter = await readFile(join(root, '.git', 'index'));
  const patch = await readPatch(fix);
  const { endpoint } = await readRecord(fix);

  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', 'fixed');

  expect(patch).toContain('-reviewed\n+fixed\n');
  expect(patch).not.toContain('deleted file');
  expect(endpoint.tree).toBe(await git(root, 'rev-parse', 'HEAD^{tree}'));
  expect(indexAfter.equals(index)).toBe(true);
});

const withDirtySubmodule = async (name: string) => {
  const root = await reviewedRepository();
  const submodule = join(root, name);

  await mkdir(submodule);
  await git(submodule, 'init', '--quiet');
  await writeFile(join(submodule, 'inner.ts'), 'inner one\n');
  await git(submodule, 'add', 'inner.ts');
  await git(submodule, 'commit', '--quiet', '-m', 'inner');
  await git(root, 'add', name);
  await git(root, 'commit', '--quiet', '-m', 'sub');

  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });

  await writeFile(join(submodule, 'inner.ts'), 'inner two\n');
  await writeFile(join(root, 'a.ts'), 'a three\n');

  return { root, review };
};

it.each(['sub', 'my sub'])(
  'reports an uncommitted edit inside the submodule %s as a gap of a chained fix',
  async (name) => {
    const { root, review } = await withDirtySubmodule(name);
    const record = await readRecord(await fixOf(root, review));

    expect(record.gaps).toContainEqual({ kind: 'submodule', path: name });
    expect(record.endpoint.status).not.toBe('complete');
  },
);

it('reports no submodule gap for an excluded dirty submodule of a chained fix', async () => {
  const { root, review } = await withDirtySubmodule('sub');
  const target: ReviewTarget = { kind: 'fix', review, findingPaths: ['a.ts'], exclude: ['sub'] };
  const record = await readRecord(await capturedReview(root, target));

  expect(record.gaps).toEqual([{ kind: 'excluded', path: 'sub' }]);
});
