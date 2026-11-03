import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, expect, it, onTestFinished } from 'vitest';

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

const setUpChain = async (registerCleanup: typeof afterAll) => {
  const root = await createTemporaryRepository(registerCleanup);
  const remote = temporaryDirectory(registerCleanup, 'tau-pr-chain-');

  await git(remote, 'init', '--quiet', '--bare', '--initial-branch=main');
  await serveGithubOriginFrom(remote, registerCleanup);
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

  const links = [
    await savedReviewLink(root, review),
    await savedReviewLink(root, firstFix),
    await savedReviewLink(root, secondFix),
  ];

  return { root, review, links };
};

let builtChain: Awaited<ReturnType<typeof setUpChain>>;
let snapshotDirectory: string;

beforeAll(async () => {
  builtChain = await setUpChain(afterAll);
  snapshotDirectory = temporaryDirectory(afterAll, 'tau-pr-chain-snapshot-');

  await cp(builtChain.root, snapshotDirectory, { recursive: true });
});

// Saved records store absolute paths, so the snapshot returns to the same root path.
beforeEach(async () => {
  await rm(builtChain.root, { recursive: true, force: true });
  await cp(snapshotDirectory, builtChain.root, { recursive: true });
});

const readEvidence = async (
  root: string,
  review: string,
  chain: { directory: string; identity: string }[],
) => {
  const agentDirectory = temporaryDirectory(onTestFinished, 'tau-pr-chain-agent-');
  const fake = createGhFake();

  fake.repositories['github.com/sQVe/tau'] = { defaultBranch: 'main' };

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
  const { root, review, links } = builtChain;

  const details = await readEvidence(root, review, links);

  expect(details).toMatchObject({
    coverage: { status: 'match' },
    review: { freshness: { status: 'stale' } },
  });
});

it('reports a mismatch when a committed edit lies outside every review', async () => {
  const { root, review, links } = builtChain;

  await writeFile(join(root, 'other.txt'), 'other\n');
  await git(root, 'add', 'other.txt');
  await git(root, 'commit', '--quiet', '-m', 'unreviewed edit');

  const details = await readEvidence(root, review, links);

  expect(details).toMatchObject({ coverage: { status: 'mismatch', link: 3 } });
});

it('reports unsupported when the root is a version 2 record', async () => {
  const { root, review } = builtChain;
  const recordPath = join(review, 'capture.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;

  delete record['gaps'];
  delete record['original'];
  delete record['endpoint'];
  await writeFile(recordPath, JSON.stringify({ ...record, version: 2 }));

  const details = await readEvidence(root, review, [await savedReviewLink(root, review)]);

  expect(details).toMatchObject({ coverage: { status: 'unsupported', link: 1 } });
});
