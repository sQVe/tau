import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../tests/gitRepository.js';
import { repositorySnapshot } from '../../tests/repositorySnapshotHarness.js';
import { createSavedFix, createSavedReview, savedReviewLink } from '../../tests/savedReview.js';
import { readChainSelection } from './chainSelection.js';

const commitFeature = async (root: string, text: string) => {
  await writeFile(join(root, 'feature.txt'), text);
  await git(root, 'add', 'feature.txt');
  await git(root, 'commit', '--quiet', '-m', 'change feature');

  return git(root, 'rev-parse', 'HEAD');
};

const committedRepository = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  return { root, mergeBase: await commitFeature(root, 'one\n') };
};

const reviewedRepository = async (reports: string[]) => {
  const { root, mergeBase } = await committedRepository();
  const reviewed = await commitFeature(root, 'two\n');
  const review = await createSavedReview(root, { kind: 'range', from: mergeBase, to: reviewed });

  await Promise.all(reports.map((name) => writeFile(join(review, name), '# Report\n')));

  return { root, mergeBase, review };
};

const fixedRepository = async () => {
  const { root, mergeBase, review } = await reviewedRepository(['reviewer.md']);

  await writeFile(join(root, 'feature.txt'), 'three\n');

  const fix = await createSavedFix(root, review, ['feature.txt']);

  return { root, mergeBase, review, fix };
};

const workers = (root: string) => join(root, '.tau', 'workers');

it('selects a saved review with a fix and changes no file', async () => {
  const { root, mergeBase, review, fix } = await fixedRepository();
  const links = [await savedReviewLink(root, review), await savedReviewLink(root, fix)];
  const before = await repositorySnapshot(root, [workers(root)]);

  const selection = await readChainSelection(root, { mergeBase });

  expect(selection).toEqual({ chain: links, gaps: [] });
  expect(await repositorySnapshot(root, [workers(root)])).toEqual(before);
});

it('selects a review that a finder and a checker reported', async () => {
  const { root, mergeBase, review } = await reviewedRepository(['finder.md', 'checker.md']);

  const selection = await readChainSelection(root, { mergeBase });

  expect(selection).toEqual({ chain: [await savedReviewLink(root, review)], gaps: [] });
});

it('ignores a review with only a finder report', async () => {
  const { root, mergeBase } = await reviewedRepository(['finder.md']);

  const selection = await readChainSelection(root, { mergeBase });

  expect(selection).toEqual({ chain: null, gaps: [{ kind: 'noChain' }] });
});

it('ignores a review whose report is a directory', async () => {
  const { root, mergeBase, review } = await reviewedRepository([]);

  await mkdir(join(review, 'reviewer.md'));

  const selection = await readChainSelection(root, { mergeBase });

  expect(selection).toEqual({ chain: null, gaps: [{ kind: 'noChain' }] });
});

it('narrows two reviews to the chain of the named review', async () => {
  const { root, mergeBase, review, fix } = await fixedRepository();
  const reviewed = await git(root, 'rev-parse', 'HEAD');
  const other = await createSavedReview(root, { kind: 'range', from: mergeBase, to: reviewed });

  await writeFile(join(other, 'reviewer.md'), '# Report\n');

  const unnamed = await readChainSelection(root, { mergeBase });
  const named = await readChainSelection(root, { mergeBase, review: fix });

  const candidates = expect.arrayContaining([[review, fix], [other]]) as string[][];

  expect(unnamed).toEqual({ chain: null, gaps: [{ kind: 'ambiguousChain', candidates }] });

  expect(named).toEqual({
    chain: [await savedReviewLink(root, review), await savedReviewLink(root, fix)],
    gaps: [],
  });
});

it('reads a repository with no review directory as no chain', async () => {
  const { root, mergeBase } = await committedRepository();

  const selection = await readChainSelection(root, { mergeBase });

  expect(selection).toEqual({ chain: null, gaps: [{ kind: 'noChain' }] });
});

it('skips a review directory with no capture record and a directory that is no review', async () => {
  const { root, mergeBase, review } = await reviewedRepository(['reviewer.md']);

  await mkdir(join(workers(root), 'review-empty'));
  await mkdir(join(workers(root), 'worker-other'));
  await writeFile(join(workers(root), 'worker-other', 'capture.json'), '{');
  await writeFile(join(workers(root), 'review-file'), '{');

  const selection = await readChainSelection(root, { mergeBase });

  expect(selection).toEqual({ chain: [await savedReviewLink(root, review)], gaps: [] });
});

it('reports a capture record with broken JSON and changes no file', async () => {
  const { root, mergeBase, review, fix } = await fixedRepository();

  await writeFile(join(fix, 'capture.json'), '{"version": 5, "target":');

  const before = await repositorySnapshot(root, [workers(root)]);

  const selection = await readChainSelection(root, { mergeBase });

  expect(selection).toEqual({
    chain: [await savedReviewLink(root, review)],
    gaps: [{ kind: 'malformedCapture', directory: fix, reason: expect.any(String) as string }],
  });

  expect(await repositorySnapshot(root, [workers(root)])).toEqual(before);
});

it('reports a named review that no chain contains', async () => {
  const { root, mergeBase } = await reviewedRepository(['reviewer.md']);
  const review = join(workers(root), 'review-absent');

  const selection = await readChainSelection(root, { mergeBase, review });

  expect(selection).toEqual({ chain: null, gaps: [{ kind: 'unknownReview', review }] });
});

it('refuses a named review outside .tau/workers', async () => {
  const { root, mergeBase } = await reviewedRepository(['reviewer.md']);

  const reading = readChainSelection(root, { mergeBase, review: join(root, 'review-elsewhere') });

  await expect(reading).rejects.toThrow('.tau/workers');
});

it('rejects a review whose capture record is a symlink', async () => {
  const { root, mergeBase, review } = await reviewedRepository(['reviewer.md']);
  const linked = join(workers(root), 'review-linked');

  await mkdir(linked);
  await symlink(join(review, 'capture.json'), join(linked, 'capture.json'));

  await expect(readChainSelection(root, { mergeBase })).rejects.toThrow('capture.json');
});

it('rejects when .tau/workers is not a directory', async () => {
  const { root, mergeBase } = await committedRepository();

  await mkdir(join(root, '.tau'));
  await writeFile(workers(root), 'not a directory\n');

  await expect(readChainSelection(root, { mergeBase })).rejects.toMatchObject({ code: 'ENOTDIR' });
});

it('reports the review of a fix that records no predecessor identity', async () => {
  const { root, mergeBase, review, fix } = await fixedRepository();
  const path = join(fix, 'capture.json');

  const record = JSON.parse(await readFile(path, 'utf8')) as {
    target: { predecessor?: unknown };
  };

  delete record.target.predecessor;
  await writeFile(path, JSON.stringify(record));

  const selection = await readChainSelection(root, { mergeBase });

  expect(selection).toEqual({
    chain: null,
    gaps: [{ kind: 'unavailableIdentity', directory: review }],
  });
});
