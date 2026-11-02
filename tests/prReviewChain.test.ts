import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it, onTestFinished } from 'vitest';

import { createGhFake } from '../src/extensions/pr/fixtures/ghFake.js';
import { createPrTool } from '../src/extensions/pr/tool.js';
import { githubOrigin, serveGithubOriginFrom } from './githubOriginFake.js';
import { createTemporaryRepository, git } from './gitRepository.js';
import { createSavedFix, createSavedReview, savedReviewLink } from './savedReview.js';
import { temporaryDirectory } from './temporaryDirectoryHarness.js';

const commitFeature = async (root: string, text: string) => {
  await writeFile(join(root, 'feature.txt'), text);
  await git(root, 'add', 'feature.txt');
  await git(root, 'commit', '--quiet', '-m', 'change feature');

  return git(root, 'rev-parse', 'HEAD');
};

const setUpChain = async () => {
  const root = await createTemporaryRepository(onTestFinished);
  const remote = temporaryDirectory(onTestFinished, 'tau-pr-chain-');

  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await serveGithubOriginFrom(remote, onTestFinished);
  await git(root, 'remote', 'add', 'origin', githubOrigin);

  const mergeBase = await commitFeature(root, 'one\n');

  await git(root, 'push', '--quiet', 'origin', 'main');
  await git(root, 'checkout', '--quiet', '-b', 'feature');

  const reviewed = await commitFeature(root, 'two\n');
  const review = await createSavedReview(root, { kind: 'range', from: mergeBase, to: reviewed });

  await writeFile(join(root, 'feature.txt'), 'three\n');
  const firstFix = await createSavedFix(root, review, ['feature.txt']);

  await commitFeature(root, 'three\n');

  await writeFile(join(root, 'feature.txt'), 'four\n');
  const secondFix = await createSavedFix(root, firstFix, ['feature.txt']);

  await commitFeature(root, 'four\n');

  const fake = createGhFake();

  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

  const links = [
    await savedReviewLink(root, review),
    await savedReviewLink(root, firstFix),
    await savedReviewLink(root, secondFix),
  ];

  return { root, review, links, fake };
};

const readEvidence = async (
  root: string,
  fake: ReturnType<typeof createGhFake>,
  review: string,
  chain: { directory: string; identity: string }[],
) => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-pr-chain-agent-');

  const tool = createPrTool(fake.exec, { agentDirectory });

  const result = await tool.execute(
    'call',
    { action: 'evidence', remote: 'origin', review, chain },
    undefined,
    undefined,
    {
      cwd: root,
      isProjectTrusted: () => true,
      ui: { notify: () => undefined },
    } as never,
  );

  return result.details;
};

it('matches a committed two-fix chain while the root freshness is stale', async () => {
  const { root, review, links, fake } = await setUpChain();

  const details = await readEvidence(root, fake, review, links);

  expect(details).toMatchObject({
    coverage: { status: 'match' },
    review: { freshness: { status: 'stale' } },
  });
});

it('reports a mismatch when a committed edit lies outside every review', async () => {
  const { root, review, links, fake } = await setUpChain();

  await writeFile(join(root, 'other.txt'), 'other\n');
  await git(root, 'add', 'other.txt');
  await git(root, 'commit', '--quiet', '-m', 'unreviewed edit');

  const details = await readEvidence(root, fake, review, links);

  expect(details).toMatchObject({ coverage: { status: 'mismatch', link: 3 } });
});

it('reports unsupported when the root is a version 2 record', async () => {
  const { root, review, fake } = await setUpChain();
  const recordPath = join(review, 'capture.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;

  delete record['gaps'];
  delete record['original'];
  delete record['endpoint'];
  await writeFile(recordPath, JSON.stringify({ ...record, version: 2 }));

  const details = await readEvidence(root, fake, review, [await savedReviewLink(root, review)]);

  expect(details).toMatchObject({ coverage: { status: 'unsupported', link: 1 } });
});
