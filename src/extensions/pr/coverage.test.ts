import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createTemporaryRepository, git } from '../../../tests/gitRepository.js';
import { createSavedFix, createSavedReview, savedReviewLink } from '../../../tests/savedReview.js';
import { noUiContext } from '../../../tests/toolContext.js';
import { createGhFake } from './fixtures/ghFake.js';
import { createPrTool } from './tool.js';
import type { PrInput } from './tool.js';

const commitAll = async (root: string, message: string) => {
  await git(root, 'add', '-A');
  await git(root, 'commit', '--quiet', '-m', message);

  return git(root, 'rev-parse', 'HEAD');
};

// A range review of one commit, then a fix capture of a working tree change, committed unchanged.
const setUpChain = async () => {
  const root = await createTemporaryRepository(onTestFinished);

  await writeFile(join(root, 'a.ts'), 'a one\n');
  const base = await commitAll(root, 'first');

  await writeFile(join(root, 'a.ts'), 'a two\n');
  const reviewed = await commitAll(root, 'reviewed');
  const review = await createSavedReview(root, { kind: 'range', from: base, to: reviewed });

  await writeFile(join(root, 'a.ts'), 'a three\n');
  const fix = await createSavedFix(root, review, ['a.ts']);

  await commitAll(root, 'fixed');

  return {
    root,
    base,
    links: [await savedReviewLink(root, review), await savedReviewLink(root, fix)],
  };
};

const runPr = async (root: string, input: PrInput) => {
  const tool = createPrTool(createGhFake().exec);
  const result = await tool.execute('call', input, undefined, undefined, noUiContext(root));

  return result.details;
};

// A shallow clone that lists its source as a promisor remote, so a missing commit could be fetched.
const partialClone = async () => {
  const source = await createTemporaryRepository(onTestFinished, 'tau-coverage-source-');

  await writeFile(join(source, 'a.ts'), 'a one\n');
  const base = await commitAll(source, 'first');

  await writeFile(join(source, 'a.ts'), 'a two\n');
  const missing = await commitAll(source, 'second');

  await git(source, 'branch', 'base', base);
  await git(source, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  await git(source, 'config', 'uploadpack.allowFilter', 'true');

  const root = await createTemporaryRepository(onTestFinished, 'tau-coverage-partial-');

  await git(root, 'config', 'core.repositoryformatversion', '1');
  await git(root, 'config', 'remote.origin.url', `file://${source}`);
  await git(root, 'config', 'remote.origin.promisor', 'true');
  await git(root, 'config', 'extensions.partialClone', 'origin');
  await git(root, 'fetch', '--quiet', '--depth=1', 'origin', 'base');
  await git(root, 'checkout', '--quiet', base);

  return { root, base, missing };
};

it('fetches no missing commit of a partial clone and refuses the revision', async () => {
  const { root, base, missing } = await partialClone();
  const before = await git(root, 'count-objects', '-v');

  const link = {
    directory: join(root, '.tau', 'workers', 'review-none'),
    identity: '0'.repeat(40),
  };

  const failure = await runPr(root, {
    action: 'coverage',
    chain: [link],
    mergeBase: base,
    head: missing,
  }).catch((error: unknown) => error);

  expect(await git(root, 'count-objects', '-v')).toBe(before);
  expect(String(failure)).toContain(missing);
});

it('reports a full review and a committed unchanged fix as match', async () => {
  const { root, base, links } = await setUpChain();

  const coverage = await runPr(root, { action: 'coverage', chain: links, mergeBase: base });

  expect(coverage).toMatchObject({ status: 'match' });
});

it('names the affected link when the head moved past the fix', async () => {
  const { root, base, links } = await setUpChain();

  await writeFile(join(root, 'b.ts'), 'b two\n');
  await commitAll(root, 'after the fix');

  const coverage = await runPr(root, { action: 'coverage', chain: links, mergeBase: base });

  expect(coverage).toMatchObject({ status: 'mismatch', link: 2 });
});

it('rejects a coverage request without a chain or mergeBase and names the parameter', async () => {
  const { root, base, links } = await setUpChain();

  await expect(runPr(root, { action: 'coverage', mergeBase: base })).rejects.toThrow('chain');
  await expect(runPr(root, { action: 'coverage', chain: links })).rejects.toThrow('mergeBase');

  await expect(runPr(root, { action: 'coverage', chain: [], mergeBase: base })).rejects.toThrow(
    'chain',
  );
});
