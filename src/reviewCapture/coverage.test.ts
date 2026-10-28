import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { repositorySnapshot } from '../../tests/repositorySnapshot.js';
import { createFreshTauDirectory } from '../tauDirectory.js';
import { readCoverage } from './coverage.js';
import { captureGeneration } from './generation.js';
import {
  generationFolderName,
  generationPatchFileName,
  inputFileName,
  recordFileName,
} from './record.js';
import type { ReviewTarget } from './target.js';

const commitAll = async (root: string, message: string) => {
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', message);

  return git(root, 'rev-parse', 'HEAD');
};

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'a.ts'), 'a one\n');
  await writeFile(join(root, 'b.ts'), 'b one\n');

  return { root, base: await commitAll(root, 'first') };
};

const capturedReview = async (root: string, target: ReviewTarget) => {
  const directory = await createFreshTauDirectory(root, 'workers', 'review-');

  await writeFile(join(directory, inputFileName), '# Review input\n\n## Capture\n');
  await captureGeneration(root, directory, target);

  return directory;
};

const fixOf = (root: string, review: string) =>
  capturedReview(root, { kind: 'fix', review, findingPaths: ['a.ts'] });

const linkOf = async (root: string, directory: string) => ({
  directory,
  identity: await git(root, 'hash-object', join(directory, recordFileName)),
});

const linksOf = (root: string, directories: string[]) =>
  Promise.all(directories.map((directory) => linkOf(root, directory)));

// A range review of one commit, then a fix capture that is committed unchanged.
const rangeChain = async () => {
  const { root, base } = await committedRepository();

  await writeFile(join(root, 'a.ts'), 'a two\n');

  const reviewed = await commitAll(root, 'reviewed');
  const review = await capturedReview(root, { kind: 'range', from: base, to: reviewed });

  await writeFile(join(root, 'a.ts'), 'a three\n');

  const fix = await fixOf(root, review);
  const head = await commitAll(root, 'fixed');

  return { root, base, reviewed, head, review, fix };
};

// A working tree review, then two chained fix captures, committed together.
const workingTreeChain = async () => {
  const { root, base } = await committedRepository();

  await writeFile(join(root, 'a.ts'), 'a two\n');
  await writeFile(join(root, 'c.ts'), 'c only in the review\n');

  const review = await capturedReview(root, { kind: 'workingTree', base: 'HEAD' });

  await writeFile(join(root, 'a.ts'), 'a three\n');
  await writeFile(join(root, 'c.ts'), 'c fixed\n');

  const firstFix = await fixOf(root, review);

  await writeFile(join(root, 'b.ts'), 'b two\n');

  const secondFix = await fixOf(root, firstFix);
  const head = await commitAll(root, 'fixed');

  return { root, base, head, review, firstFix, secondFix };
};

it('matches a range review and a committed unchanged fix', async () => {
  const { root, base, reviewed, head, review, fix } = await rangeChain();
  const links = await linksOf(root, [review, fix]);

  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage).toMatchObject({
    status: 'match',
    links: [{ head: reviewed }, { head: reviewed }],
  });
});

it('matches a working tree review and two chained fixes', async () => {
  const { root, base, head, review, firstFix, secondFix } = await workingTreeChain();
  const links = await linksOf(root, [review, firstFix, secondFix]);

  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage.status).toBe('match');
});

it('finds a mismatch when two fix links swap places', async () => {
  const { root, base, head, review, firstFix, secondFix } = await workingTreeChain();
  const links = await linksOf(root, [review, secondFix, firstFix]);

  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage).toMatchObject({ status: 'mismatch', link: 2 });
});

it('finds a mismatch when a saved artifact changed', async () => {
  const { root, base, head, review, fix } = await rangeChain();
  const links = await linksOf(root, [review, fix]);

  await appendFile(join(review, generationFolderName, generationPatchFileName), 'changed\n');

  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage).toMatchObject({ status: 'mismatch', link: 1 });
});

it('finds a mismatch when the head commits an edit after the last fix', async () => {
  const { root, base, review, fix } = await rangeChain();
  const links = await linksOf(root, [review, fix]);

  await writeFile(join(root, 'a.ts'), 'a four\n');

  const head = await commitAll(root, 'edited after the fix');
  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage).toMatchObject({ status: 'mismatch', link: 2 });
  expect(coverage.reasons).toEqual([expect.stringContaining('head tree')]);
});

it('finds a mismatch when a full capture follows the root', async () => {
  const { root, base, reviewed, head, review } = await rangeChain();
  const later = await capturedReview(root, { kind: 'range', from: reviewed, to: head });
  const links = await linksOf(root, [review, later]);

  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage).toMatchObject({ status: 'mismatch', link: 2 });
});

it('finds a mismatch on another merge base with the same patch', async () => {
  const { root, base } = await committedRepository();

  await git(root, 'switch', '--quiet', '-c', 'topic');
  await writeFile(join(root, 'a.ts'), 'a two\n');

  const reviewed = await commitAll(root, 'reviewed');
  const review = await capturedReview(root, { kind: 'range', from: base, to: reviewed });

  await git(root, 'switch', '--quiet', 'main');
  await writeFile(join(root, 'c.ts'), 'c on the new base\n');

  const mergeBase = await commitAll(root, 'moved base');

  await git(root, 'cherry-pick', reviewed);

  const head = await git(root, 'rev-parse', 'HEAD');
  const links = await linksOf(root, [review]);

  const coverage = await readCoverage(root, { links, mergeBase, head });

  expect(await git(root, 'diff', mergeBase, head)).toBe(await git(root, 'diff', base, reviewed));
  expect(coverage).toMatchObject({ status: 'mismatch', link: 1 });
  expect(coverage.reasons[0]).toContain('merge base');
});

it('reads a chain whose endpoint ref and objects were pruned as unknown', async () => {
  const { root, base, head, review, firstFix, secondFix } = await workingTreeChain();
  const links = await linksOf(root, [review, firstFix, secondFix]);
  await git(root, 'update-ref', '-d', `refs/tau/review-captures/${basename(review)}`);
  await git(root, 'prune', '--expire=now');

  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage).toMatchObject({ status: 'unknown', link: 1 });
});

it('reads a version 3 root as unsupported', async () => {
  const { root, base } = await committedRepository();

  await writeFile(join(root, 'a.ts'), 'a two\n');

  const head = await commitAll(root, 'reviewed');
  const review = await capturedReview(root, { kind: 'range', from: base, to: head });
  const recordPath = join(review, recordFileName);
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
  const { endpoint: _endpoint, ...withoutEndpoint } = record;

  await writeFile(recordPath, JSON.stringify({ ...withoutEndpoint, version: 3 }));

  const links = await linksOf(root, [review]);
  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage).toMatchObject({ status: 'unsupported', link: 1 });
});

it('reads a capture with an excluded path as unsupported', async () => {
  const { root, base } = await committedRepository();

  await writeFile(join(root, 'a.ts'), 'a two\n');
  await writeFile(join(root, 'b.ts'), 'b two\n');

  const head = await commitAll(root, 'reviewed');

  const review = await capturedReview(root, {
    kind: 'range',
    from: base,
    to: head,
    exclude: ['b.ts'],
  });

  const links = await linksOf(root, [review]);
  const coverage = await readCoverage(root, { links, mergeBase: base, head });

  expect(coverage).toMatchObject({ status: 'unsupported', link: 1 });
  expect(coverage.reasons.join('\n')).toContain('b.ts');
});

it('refuses a review directory outside .tau/workers', async () => {
  const { root, base } = await committedRepository();
  const directory = join(root, 'review-outside');

  await mkdir(directory);

  const reading = readCoverage(root, {
    links: [{ directory, identity: base }],
    mergeBase: base,
    head: base,
  });

  await expect(reading).rejects.toThrow('.tau/workers');
});

it('changes no review file, ref, index, or object', async () => {
  const { root, base, head, review, firstFix, secondFix } = await workingTreeChain();
  const directories = [review, firstFix, secondFix];
  const links = await linksOf(root, directories);
  const before = await repositorySnapshot(root, directories);

  await readCoverage(root, { links, mergeBase: base, head });
  await readCoverage(root, { links: links.toReversed(), mergeBase: base, head });
  await readCoverage(root, { links, mergeBase: head, head: base });

  expect(await repositorySnapshot(root, directories)).toEqual(before);
});

it('reads a review directory with no capture as unknown and changes nothing', async () => {
  const { root, base } = await committedRepository();
  const directory = await createFreshTauDirectory(root, 'workers', 'review-');
  const links = [{ directory, identity: base }];
  const before = await repositorySnapshot(root, [directory]);

  const coverage = await readCoverage(root, { links, mergeBase: base, head: base });

  expect(coverage).toMatchObject({ status: 'unknown', link: 1 });
  expect(await repositorySnapshot(root, [directory])).toEqual(before);
});

it('reads a malformed capture record as unknown and changes nothing', async () => {
  const { root, base } = await committedRepository();

  await writeFile(join(root, 'a.ts'), 'a two\n');

  const reviewed = await commitAll(root, 'reviewed');
  const review = await capturedReview(root, { kind: 'range', from: base, to: reviewed });

  await writeFile(join(review, recordFileName), '{"version": 5, "target":');

  const links = await linksOf(root, [review]);
  const before = await repositorySnapshot(root, [review]);

  const coverage = await readCoverage(root, { links, mergeBase: base, head: reviewed });

  expect(coverage).toMatchObject({ status: 'unknown', link: 1 });
  expect(await repositorySnapshot(root, [review])).toEqual(before);
});
